import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { SaasSeedService } from './saas-seed.service';
import {
  computeQuota,
  currentBillingPeriod,
  type EntitlementDto,
  type QuotaDto,
  toPlanDto,
  toSubscriptionDto,
  toTenantDto,
} from './saas.types';

export interface DubbingActor {
  id: number;
  isRoot?: boolean;
}

@Injectable()
export class SaasEntitlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seedService: SaasSeedService,
  ) {}

  async ensurePersonalTenantForUser(
    userId: number,
    options?: {
      tenantName?: string;
      contactEmail?: string | null;
      fallbackName?: string;
    },
  ): Promise<EntitlementDto> {
    await this.seedService.ensureDefaultPlans();

    const existing = await this.findPrimaryMembership(userId);
    if (existing) {
      return this.buildEntitlement(existing);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    const defaultPlan =
      (await this.prisma.plan.findFirst({
        where: { isDefault: true, isActive: true, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      })) ??
      (await this.prisma.plan.findFirst({
        where: { isActive: true, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      }));

    const fullName = [user?.firstName, user?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const tenantName =
      options?.tenantName?.trim() ||
      options?.fallbackName?.trim() ||
      fullName ||
      user?.username ||
      `Workspace ${userId}`;
    const contactEmail = options?.contactEmail ?? user?.email ?? null;
    const code = this.generateTenantCode(user?.username ?? `user-${userId}`);

    await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          code,
          name: tenantName,
          type: 'PERSONAL',
          status: 'ACTIVE',
          contactEmail,
        },
      });

      await tx.tenantMember.create({
        data: {
          tenantId: tenant.id,
          userId,
          role: 'OWNER',
        },
      });

      if (defaultPlan) {
        await tx.tenantSubscription.create({
          data: {
            tenantId: tenant.id,
            planId: defaultPlan.id,
            status: 'ACTIVE',
            billingCycle: 'MONTHLY',
            startsAt: new Date(),
            expiresAt: null,
            note: 'Tự động kích hoạt gói mặc định khi đăng ký',
          },
        });
      }
    });

    const created = await this.findPrimaryMembership(userId);
    if (!created) {
      throw new HttpException(
        {
          code: 'NO_SUBSCRIPTION',
          message: 'Không thể khởi tạo không gian làm việc cho người dùng',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return this.buildEntitlement(created);
  }

  async getUserEntitlement(
    userId: number,
    options?: { createIfMissing?: boolean },
  ): Promise<EntitlementDto | null> {
    const membership = await this.findPrimaryMembership(userId);
    if (!membership) {
      if (options?.createIfMissing) {
        return this.ensurePersonalTenantForUser(userId);
      }
      return null;
    }
    return this.buildEntitlement(membership);
  }

  async assertCanDub(actor: DubbingActor): Promise<EntitlementDto | null> {
    if (actor.isRoot) {
      return this.getUserEntitlement(actor.id, { createIfMissing: false });
    }

    const entitlement = await this.getUserEntitlement(actor.id, {
      createIfMissing: true,
    });

    if (!entitlement) {
      const quota = computeQuota({
        tenantStatus: 'ACTIVE',
        subscription: null,
        usedSeconds: 0,
      });
      throw new HttpException(
        {
          code: 'NO_SUBSCRIPTION',
          message:
            'Tài khoản chưa có gói dịch vụ hoạt động. Vui lòng nâng cấp gói để tiếp tục.',
          quota,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const { quota } = entitlement;
    if (quota.canDub) {
      return entitlement;
    }

    if (quota.blockReason === 'TENANT_SUSPENDED') {
      throw new ForbiddenException({
        code: 'TENANT_SUSPENDED',
        message:
          'Không gian làm việc của bạn đang tạm khóa. Vui lòng liên hệ quản trị viên.',
        quota,
      });
    }

    const messageMap: Record<
      Exclude<typeof quota.blockReason, null | 'TENANT_SUSPENDED'>,
      string
    > = {
      NO_SUBSCRIPTION:
        'Tài khoản chưa có gói dịch vụ hoạt động. Vui lòng nâng cấp gói để tiếp tục.',
      SUBSCRIPTION_EXPIRED:
        'Gói dịch vụ của bạn đã hết hạn. Vui lòng gia hạn hoặc nâng cấp gói.',
      QUOTA_EXCEEDED:
        'Bạn đã dùng hết hạn mức phút lồng tiếng trong tháng này. Vui lòng nâng cấp gói.',
    };

    const code = quota.blockReason ?? 'NO_SUBSCRIPTION';
    throw new HttpException(
      {
        code,
        message: messageMap[code],
        quota,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  async recordDubbingUsage(
    actor: DubbingActor,
    sessions: Array<{ watchedSeconds: number; dubbedCues?: number }>,
  ): Promise<QuotaDto> {
    const entitlement = await this.getUserEntitlement(actor.id, {
      createIfMissing: !actor.isRoot,
    });

    const period = currentBillingPeriod();
    if (!entitlement) {
      return computeQuota({
        tenantStatus: 'ACTIVE',
        subscription: null,
        usedSeconds: 0,
        period,
      });
    }

    const addedSeconds = sessions.reduce(
      (sum, item) => sum + Math.max(0, Math.round(item.watchedSeconds || 0)),
      0,
    );
    const addedCues = sessions.reduce(
      (sum, item) => sum + Math.max(0, Math.round(item.dubbedCues || 0)),
      0,
    );
    const addedCount = sessions.length;

    const usage = await this.prisma.tenantUsageMonthly.upsert({
      where: {
        tenantId_period: {
          tenantId: entitlement.tenant.id,
          period,
        },
      },
      create: {
        tenantId: entitlement.tenant.id,
        period,
        usedSeconds: addedSeconds,
        dubbedCues: addedCues,
        sessionsCount: addedCount,
      },
      update: {
        usedSeconds: { increment: addedSeconds },
        dubbedCues: { increment: addedCues },
        sessionsCount: { increment: addedCount },
      },
    });

    return computeQuota({
      tenantStatus: entitlement.tenant.status,
      subscription: entitlement.subscription,
      usedSeconds: usage.usedSeconds,
      period,
    });
  }

  private async findPrimaryMembership(userId: number) {
    const memberships = await this.prisma.tenantMember.findMany({
      where: {
        userId,
        tenant: { deletedAt: null },
      },
      include: {
        tenant: {
          include: {
            subscriptions: {
              include: { plan: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (memberships.length === 0) return null;

    // Prefer an active ORGANIZATION membership if present, else first active, else first membership.
    const activeOrg = memberships.find(
      (m) => m.tenant.type === 'ORGANIZATION' && m.tenant.status === 'ACTIVE',
    );
    if (activeOrg) return activeOrg;

    const activePersonal = memberships.find((m) => m.tenant.status === 'ACTIVE');
    return activePersonal ?? memberships[0];
  }

  private async buildEntitlement(
    membership: NonNullable<
      Awaited<ReturnType<SaasEntitlementService['findPrimaryMembership']>>
    >,
  ): Promise<EntitlementDto> {
    const period = currentBillingPeriod();
    const usage = await this.prisma.tenantUsageMonthly.findUnique({
      where: {
        tenantId_period: {
          tenantId: membership.tenantId,
          period,
        },
      },
    });

    const activeSub =
      membership.tenant.subscriptions.find((s) => s.status === 'ACTIVE') ??
      membership.tenant.subscriptions.find((s) => s.status === 'EXPIRED') ??
      null;

    const subscriptionDto = activeSub ? toSubscriptionDto(activeSub) : null;
    const planDto = activeSub ? toPlanDto(activeSub.plan) : null;
    const quota = computeQuota({
      tenantStatus: membership.tenant.status,
      subscription: activeSub,
      usedSeconds: usage?.usedSeconds ?? 0,
      period,
    });

    return {
      tenant: toTenantDto(membership.tenant),
      memberRole: membership.role,
      subscription: subscriptionDto,
      plan: planDto,
      quota,
    };
  }

  private generateTenantCode(seed: string): string {
    const slug = seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    const suffix = randomBytes(3).toString('hex');
    return `${slug || 'tenant'}-${suffix}`;
  }
}
