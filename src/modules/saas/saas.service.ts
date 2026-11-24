import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '$/prisma/client';
import { PrismaService } from '~/modules/prisma/prisma.service';
import type { PaginationType } from '~/types/pagination.type';
import { SaasEntitlementService } from './saas-entitlement.service';
import { SaasSeedService } from './saas-seed.service';
import {
  type BillingCycleValue,
  computeQuota,
  currentBillingPeriod,
  type PlanDto,
  type QuotaDto,
  type SaasOverviewDto,
  secondsToMinutes,
  type SubscriptionDto,
  type TenantDetailDto,
  type TenantDto,
  type TenantListItemDto,
  type TenantMemberDto,
  type TenantMemberRoleValue,
  type TenantStatusValue,
  type TenantTypeValue,
  toPlanDto,
  toSubscriptionDto,
  toTenantDto,
  toUpgradeRequestDto,
  type UpgradeRequestDto,
  type UpgradeRequestStatusValue,
  type UserSummaryDto,
} from './saas.types';

const BILLING_CYCLES: BillingCycleValue[] = ['MONTHLY', 'YEARLY', 'LIFETIME'];
const TENANT_TYPES: TenantTypeValue[] = ['PERSONAL', 'ORGANIZATION'];
const TENANT_STATUSES: TenantStatusValue[] = ['ACTIVE', 'SUSPENDED'];
const MEMBER_ROLES: TenantMemberRoleValue[] = ['OWNER', 'ADMIN', 'MEMBER'];
const UPGRADE_STATUSES: UpgradeRequestStatusValue[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
];

function buildPagination(
  page: number,
  limit: number,
  total: number,
): PaginationType {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    totalItems: total,
    totalPage: totalPages,
  };
}

function parsePositiveInt(
  value: unknown,
  fallback: number,
  max = 100,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function resolveExpiresAt(params: {
  expiresAt?: string | null;
  durationDays?: number | null;
  billingCycle: BillingCycleValue;
  startsAt: Date;
  isFreePlan?: boolean;
}): Date | null {
  if (params.expiresAt !== undefined) {
    if (params.expiresAt === null || params.expiresAt === '') return null;
    const d = new Date(params.expiresAt);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('expiresAt không hợp lệ');
    }
    return d;
  }
  if (
    params.durationDays !== undefined &&
    params.durationDays !== null
  ) {
    const days = Number(params.durationDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('durationDays phải lớn hơn 0');
    }
    return new Date(params.startsAt.getTime() + days * 86_400_000);
  }
  if (params.billingCycle === 'LIFETIME' || params.isFreePlan) {
    return null;
  }
  const defaultDays = params.billingCycle === 'YEARLY' ? 365 : 30;
  return new Date(params.startsAt.getTime() + defaultDays * 86_400_000);
}

@Injectable()
export class SaasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seedService: SaasSeedService,
    private readonly entitlementService: SaasEntitlementService,
  ) {}

  // ==================== PUBLIC ====================

  async listPublicPlans(): Promise<PlanDto[]> {
    await this.seedService.ensureDefaultPlans();
    const plans = await this.prisma.plan.findMany({
      where: {
        isActive: true,
        isPublic: true,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return plans.map(toPlanDto);
  }

  // ==================== DESKTOP USER (/saas/me) ====================

  async listMyUpgradeRequests(userId: number): Promise<UpgradeRequestDto[]> {
    const entitlement = await this.entitlementService.getUserEntitlement(
      userId,
      { createIfMissing: true },
    );
    if (!entitlement) return [];

    const rows = await this.prisma.upgradeRequest.findMany({
      where: { tenantId: entitlement.tenant.id },
      include: {
        tenant: true,
        requestedPlan: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(toUpgradeRequestDto);
  }

  async createMyUpgradeRequest(
    userId: number,
    body: {
      planId?: number;
      billingCycle?: 'MONTHLY' | 'YEARLY';
      contactNote?: string;
    },
  ): Promise<UpgradeRequestDto> {
    const planId = Number(body?.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      throw new BadRequestException('planId không hợp lệ');
    }

    const billingCycle =
      body.billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY';

    const entitlement = await this.entitlementService.getUserEntitlement(
      userId,
      { createIfMissing: true },
    );
    if (!entitlement) {
      throw new NotFoundException('Không tìm thấy không gian làm việc');
    }

    const plan = await this.prisma.plan.findFirst({
      where: { id: planId, isActive: true, deletedAt: null },
    });
    if (!plan) {
      throw new NotFoundException('Không tìm thấy gói dịch vụ');
    }

    const created = await this.prisma.upgradeRequest.create({
      data: {
        tenantId: entitlement.tenant.id,
        userId,
        requestedPlanId: plan.id,
        billingCycle,
        status: 'PENDING',
        contactNote: body.contactNote?.trim() || null,
      },
      include: {
        tenant: true,
        requestedPlan: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return toUpgradeRequestDto(created);
  }

  // ==================== ADMIN: OVERVIEW ====================

  async getAdminOverview(): Promise<SaasOverviewDto> {
    await this.seedService.ensureDefaultPlans();
    const currentPeriod = currentBillingPeriod();

    const [
      totalTenants,
      activeTenants,
      suspendedTenants,
      totalUsers,
      activeSubs,
      pendingUpgradeRequests,
      usageAgg,
    ] = await Promise.all([
      this.prisma.tenant.count({ where: { deletedAt: null } }),
      this.prisma.tenant.count({ where: { deletedAt: null, status: 'ACTIVE' } }),
      this.prisma.tenant.count({
        where: { deletedAt: null, status: 'SUSPENDED' },
      }),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.tenantSubscription.findMany({
        where: { status: 'ACTIVE', tenant: { deletedAt: null } },
        include: { plan: true },
      }),
      this.prisma.upgradeRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.tenantUsageMonthly.aggregate({
        where: { period: currentPeriod },
        _sum: { usedSeconds: true },
      }),
    ]);

    const distMap = new Map<
      number,
      { planId: number; code: string; name: string; count: number }
    >();
    for (const sub of activeSubs) {
      const existing = distMap.get(sub.planId);
      if (existing) {
        existing.count += 1;
      } else {
        distMap.set(sub.planId, {
          planId: sub.plan.id,
          code: sub.plan.code,
          name: sub.plan.name,
          count: 1,
        });
      }
    }

    return {
      totalTenants,
      activeTenants,
      suspendedTenants,
      totalUsers,
      activeSubscriptions: activeSubs.length,
      pendingUpgradeRequests,
      currentPeriod,
      totalUsedMinutesThisMonth: secondsToMinutes(
        usageAgg._sum.usedSeconds ?? 0,
      ),
      planDistribution: [...distMap.values()].sort((a, b) => b.count - a.count),
    };
  }

  // ==================== ADMIN: PLANS ====================

  async listAdminPlans(): Promise<PlanDto[]> {
    await this.seedService.ensureDefaultPlans();
    const plans = await this.prisma.plan.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return plans.map(toPlanDto);
  }

  async createAdminPlan(body: {
    code: string;
    name: string;
    description?: string | null;
    badge?: string | null;
    priceMonthly: number;
    priceYearly: number;
    currency?: string;
    monthlyMinutesLimit?: number | null;
    maxSeats: number;
    features?: string[];
    isPublic?: boolean;
    isDefault?: boolean;
    isHighlighted?: boolean;
    sortOrder?: number;
    isActive?: boolean;
  }): Promise<PlanDto> {
    const code = body?.code?.trim().toLowerCase();
    const name = body?.name?.trim();
    if (!code || !name) {
      throw new BadRequestException('code và name là bắt buộc');
    }

    const duplicate = await this.prisma.plan.findUnique({ where: { code } });
    if (duplicate) {
      throw new ConflictException(`Mã gói "${code}" đã tồn tại`);
    }

    const priceMonthly = Number(body.priceMonthly ?? 0);
    const priceYearly = Number(body.priceYearly ?? 0);
    const maxSeats = Number(body.maxSeats ?? 1);
    const monthlyMinutesLimit =
      body.monthlyMinutesLimit === null ||
      body.monthlyMinutesLimit === undefined
        ? null
        : Number(body.monthlyMinutesLimit);

    if (
      !Number.isFinite(priceMonthly) ||
      priceMonthly < 0 ||
      !Number.isFinite(priceYearly) ||
      priceYearly < 0 ||
      !Number.isInteger(maxSeats) ||
      maxSeats < 1
    ) {
      throw new BadRequestException('Giá hoặc số thành viên không hợp lệ');
    }

    if (
      monthlyMinutesLimit !== null &&
      (!Number.isInteger(monthlyMinutesLimit) || monthlyMinutesLimit < 0)
    ) {
      throw new BadRequestException('Hạn mức phút/tháng không hợp lệ');
    }

    const features = Array.isArray(body.features)
      ? body.features.map((f) => String(f).trim()).filter(Boolean)
      : [];

    const created = await this.prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.plan.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.plan.create({
        data: {
          code,
          name,
          description: body.description?.trim() || null,
          badge: body.badge?.trim() || null,
          priceMonthly: Math.round(priceMonthly),
          priceYearly: Math.round(priceYearly),
          currency: body.currency?.trim() || 'VND',
          monthlyMinutesLimit,
          maxSeats,
          features,
          isPublic: body.isPublic ?? true,
          isDefault: body.isDefault ?? false,
          isHighlighted: body.isHighlighted ?? false,
          sortOrder: Number.isFinite(Number(body.sortOrder))
            ? Number(body.sortOrder)
            : 0,
          isActive: body.isActive ?? true,
        },
      });
    });

    return toPlanDto(created);
  }

  async updateAdminPlan(
    id: number,
    body: Partial<{
      code: string;
      name: string;
      description: string | null;
      badge: string | null;
      priceMonthly: number;
      priceYearly: number;
      currency: string;
      monthlyMinutesLimit: number | null;
      maxSeats: number;
      features: string[];
      isPublic: boolean;
      isDefault: boolean;
      isHighlighted: boolean;
      sortOrder: number;
      isActive: boolean;
    }>,
  ): Promise<PlanDto> {
    const existing = await this.prisma.plan.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy gói dịch vụ');
    }

    if (body.code !== undefined) {
      const nextCode = body.code.trim().toLowerCase();
      if (!nextCode) throw new BadRequestException('Mã gói không hợp lệ');
      if (nextCode !== existing.code) {
        const dup = await this.prisma.plan.findUnique({
          where: { code: nextCode },
        });
        if (dup) throw new ConflictException(`Mã gói "${nextCode}" đã tồn tại`);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (body.isDefault === true) {
        await tx.plan.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      return tx.plan.update({
        where: { id },
        data: {
          ...(body.code !== undefined
            ? { code: body.code.trim().toLowerCase() }
            : {}),
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.description !== undefined
            ? { description: body.description?.trim() || null }
            : {}),
          ...(body.badge !== undefined
            ? { badge: body.badge?.trim() || null }
            : {}),
          ...(body.priceMonthly !== undefined
            ? { priceMonthly: Math.max(0, Math.round(Number(body.priceMonthly))) }
            : {}),
          ...(body.priceYearly !== undefined
            ? { priceYearly: Math.max(0, Math.round(Number(body.priceYearly))) }
            : {}),
          ...(body.currency !== undefined
            ? { currency: body.currency.trim() || 'VND' }
            : {}),
          ...(body.monthlyMinutesLimit !== undefined
            ? {
                monthlyMinutesLimit:
                  body.monthlyMinutesLimit === null
                    ? null
                    : Math.max(0, Math.round(Number(body.monthlyMinutesLimit))),
              }
            : {}),
          ...(body.maxSeats !== undefined
            ? { maxSeats: Math.max(1, Math.round(Number(body.maxSeats))) }
            : {}),
          ...(body.features !== undefined
            ? {
                features: Array.isArray(body.features)
                  ? body.features.map((f) => String(f).trim()).filter(Boolean)
                  : [],
              }
            : {}),
          ...(body.isPublic !== undefined ? { isPublic: Boolean(body.isPublic) } : {}),
          ...(body.isDefault !== undefined
            ? { isDefault: Boolean(body.isDefault) }
            : {}),
          ...(body.isHighlighted !== undefined
            ? { isHighlighted: Boolean(body.isHighlighted) }
            : {}),
          ...(body.sortOrder !== undefined
            ? { sortOrder: Number(body.sortOrder) }
            : {}),
          ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
        },
      });
    });

    return toPlanDto(updated);
  }

  async deleteAdminPlan(id: number): Promise<{ deleted: true }> {
    const existing = await this.prisma.plan.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy gói dịch vụ');
    }

    const activeSubsCount = await this.prisma.tenantSubscription.count({
      where: { planId: id, status: 'ACTIVE' },
    });
    if (activeSubsCount > 0) {
      throw new ConflictException(
        'Không thể xóa gói đang có Tenant sử dụng. Hãy chuyển các Tenant sang gói khác trước.',
      );
    }

    await this.prisma.plan.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
        isPublic: false,
        isDefault: false,
      },
    });

    return { deleted: true };
  }

  // ==================== ADMIN: TENANTS ====================

  async listAdminTenants(query: {
    page?: unknown;
    limit?: unknown;
    search?: string;
    type?: string;
    status?: string;
    planId?: unknown;
  }): Promise<{ data: TenantListItemDto[]; pagination: PaginationType }> {
    const page = parsePositiveInt(query.page, 1, 10000);
    const limit = parsePositiveInt(query.limit, 20, 100);
    const search = query.search?.trim();
    const period = currentBillingPeriod();

    const where: Prisma.TenantWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { contactEmail: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (query.type && TENANT_TYPES.includes(query.type as TenantTypeValue)) {
      where.type = query.type as TenantTypeValue;
    }
    if (
      query.status &&
      TENANT_STATUSES.includes(query.status as TenantStatusValue)
    ) {
      where.status = query.status as TenantStatusValue;
    }
    if (query.planId !== undefined && query.planId !== '') {
      const planId = Number(query.planId);
      if (Number.isInteger(planId) && planId > 0) {
        where.subscriptions = {
          some: { planId, status: 'ACTIVE' },
        };
      }
    }

    const [total, tenants] = await Promise.all([
      this.prisma.tenant.count({ where }),
      this.prisma.tenant.findMany({
        where,
        include: {
          _count: { select: { members: true } },
          subscriptions: {
            where: { status: 'ACTIVE' },
            include: { plan: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          monthlyUsages: {
            where: { period },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const data: TenantListItemDto[] = tenants.map((t) => {
      const activeSub = t.subscriptions[0] ?? null;
      const usage = t.monthlyUsages[0] ?? null;
      const usedSeconds = usage?.usedSeconds ?? 0;
      const limitMinutes = activeSub
        ? activeSub.monthlyMinutesLimitOverride ??
          activeSub.plan.monthlyMinutesLimit
        : null;

      return {
        ...toTenantDto(t),
        memberCount: t._count.members,
        activeSubscription: activeSub ? toSubscriptionDto(activeSub) : null,
        currentUsage: {
          period,
          usedSeconds,
          usedMinutes: secondsToMinutes(usedSeconds),
          limitMinutes,
        },
      };
    });

    return {
      data,
      pagination: buildPagination(page, limit, total),
    };
  }

  async getAdminTenantDetail(id: number): Promise<TenantDetailDto> {
    const period = currentBillingPeriod();
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                firstName: true,
                lastName: true,
                isActive: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        subscriptions: {
          include: { plan: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
        monthlyUsages: {
          orderBy: { period: 'desc' },
          take: 12,
        },
        upgradeRequests: {
          include: {
            requestedPlan: true,
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Không tìm thấy Tenant');
    }

    const activeSub =
      tenant.subscriptions.find((s) => s.status === 'ACTIVE') ??
      tenant.subscriptions.find((s) => s.status === 'EXPIRED') ??
      null;
    const currentUsage = tenant.monthlyUsages.find((u) => u.period === period);

    return {
      ...toTenantDto(tenant),
      members: tenant.members.map((m) => ({
        id: m.id,
        tenantId: m.tenantId,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt.toISOString(),
        user: m.user,
      })),
      subscriptions: tenant.subscriptions.map(toSubscriptionDto),
      usageHistory: tenant.monthlyUsages.map((u) => ({
        id: u.id,
        tenantId: u.tenantId,
        period: u.period,
        usedSeconds: u.usedSeconds,
        usedMinutes: secondsToMinutes(u.usedSeconds),
        dubbedCues: u.dubbedCues,
        sessionsCount: u.sessionsCount,
      })),
      upgradeRequests: tenant.upgradeRequests.map(toUpgradeRequestDto),
      quota: computeQuota({
        tenantStatus: tenant.status,
        subscription: activeSub,
        usedSeconds: currentUsage?.usedSeconds ?? 0,
        period,
      }),
    };
  }

  async createAdminTenant(body: {
    name: string;
    code?: string;
    type?: TenantTypeValue;
    contactEmail?: string | null;
    notes?: string | null;
    ownerUserId?: number;
    initialPlanId?: number;
    billingCycle?: BillingCycleValue;
    durationDays?: number | null;
    expiresAt?: string | null;
  }): Promise<TenantDetailDto> {
    await this.seedService.ensureDefaultPlans();
    const name = body?.name?.trim();
    if (!name) {
      throw new BadRequestException('Tên Tenant là bắt buộc');
    }

    const type: TenantTypeValue =
      body.type && TENANT_TYPES.includes(body.type)
        ? body.type
        : 'ORGANIZATION';
    const rawCode = body.code?.trim().toLowerCase();
    const code =
      rawCode ||
      `${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'org'}-${randomBytes(3).toString('hex')}`;

    const duplicate = await this.prisma.tenant.findUnique({ where: { code } });
    if (duplicate) {
      throw new ConflictException(`Mã Tenant "${code}" đã tồn tại`);
    }

    if (body.ownerUserId !== undefined) {
      const owner = await this.prisma.user.findUnique({
        where: { id: Number(body.ownerUserId) },
      });
      if (!owner) {
        throw new NotFoundException('Không tìm thấy người dùng chủ sở hữu');
      }
    }

    let plan = body.initialPlanId
      ? await this.prisma.plan.findFirst({
          where: { id: Number(body.initialPlanId), deletedAt: null },
        })
      : await this.prisma.plan.findFirst({
          where: { isDefault: true, isActive: true, deletedAt: null },
        });
    if (body.initialPlanId && !plan) {
      throw new NotFoundException('Không tìm thấy gói dịch vụ khởi tạo');
    }

    const billingCycle: BillingCycleValue =
      body.billingCycle && BILLING_CYCLES.includes(body.billingCycle)
        ? body.billingCycle
        : 'MONTHLY';
    const startsAt = new Date();
    const expiresAt = plan
      ? resolveExpiresAt({
          expiresAt: body.expiresAt,
          durationDays: body.durationDays,
          billingCycle,
          startsAt,
          isFreePlan: plan.priceMonthly === 0 && plan.priceYearly === 0,
        })
      : null;

    const tenant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({
        data: {
          code,
          name,
          type,
          status: 'ACTIVE',
          contactEmail: body.contactEmail?.trim() || null,
          notes: body.notes?.trim() || null,
        },
      });

      if (body.ownerUserId !== undefined) {
        await tx.tenantMember.create({
          data: {
            tenantId: created.id,
            userId: Number(body.ownerUserId),
            role: 'OWNER',
          },
        });
      }

      if (plan) {
        await tx.tenantSubscription.create({
          data: {
            tenantId: created.id,
            planId: plan.id,
            status: 'ACTIVE',
            billingCycle,
            startsAt,
            expiresAt,
            note: 'Khởi tạo từ Admin',
          },
        });
      }

      return created;
    });

    return this.getAdminTenantDetail(tenant.id);
  }

  async updateAdminTenant(
    id: number,
    body: {
      name?: string;
      status?: TenantStatusValue;
      type?: TenantTypeValue;
      contactEmail?: string | null;
      notes?: string | null;
    },
  ): Promise<TenantDto> {
    const existing = await this.prisma.tenant.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy Tenant');
    }

    if (body.status && !TENANT_STATUSES.includes(body.status)) {
      throw new BadRequestException('Trạng thái Tenant không hợp lệ');
    }
    if (body.type && !TENANT_TYPES.includes(body.type)) {
      throw new BadRequestException('Loại Tenant không hợp lệ');
    }

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.contactEmail !== undefined
          ? { contactEmail: body.contactEmail?.trim() || null }
          : {}),
        ...(body.notes !== undefined
          ? { notes: body.notes?.trim() || null }
          : {}),
      },
    });

    return toTenantDto(updated);
  }

  // ==================== ADMIN: TENANT MEMBERS ====================

  async addAdminTenantMember(
    tenantId: number,
    body: {
      userId?: number;
      identifier?: string;
      role?: TenantMemberRoleValue;
    },
  ): Promise<TenantMemberDto> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      include: {
        _count: { select: { members: true } },
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { plan: true },
          take: 1,
        },
      },
    });
    if (!tenant) {
      throw new NotFoundException('Không tìm thấy Tenant');
    }

    let user = null as Awaited<ReturnType<PrismaService['user']['findFirst']>>;
    if (body.userId !== undefined) {
      user = await this.prisma.user.findFirst({
        where: { id: Number(body.userId), deletedAt: null },
      });
    } else if (body.identifier?.trim()) {
      const ident = body.identifier.trim();
      user = await this.prisma.user.findFirst({
        where: {
          deletedAt: null,
          OR: [
            { username: ident },
            { email: { equals: ident.toLowerCase(), mode: 'insensitive' } },
          ],
        },
      });
    } else {
      throw new BadRequestException('Cần truyền userId hoặc identifier (email/username)');
    }

    if (!user) {
      throw new NotFoundException('Không tìm thấy người dùng');
    }

    const role: TenantMemberRoleValue =
      body.role && MEMBER_ROLES.includes(body.role) ? body.role : 'MEMBER';

    const existingMember = await this.prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId: user.id } },
    });

    if (!existingMember) {
      const maxSeats = tenant.subscriptions[0]?.plan.maxSeats;
      if (maxSeats && tenant._count.members >= maxSeats) {
        throw new ConflictException(
          `Tenant đã đạt giới hạn tối đa ${maxSeats} thành viên theo gói hiện tại`,
        );
      }
    }

    const member = existingMember
      ? await this.prisma.tenantMember.update({
          where: { id: existingMember.id },
          data: { role },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                firstName: true,
                lastName: true,
                isActive: true,
              },
            },
          },
        })
      : await this.prisma.tenantMember.create({
          data: {
            tenantId,
            userId: user.id,
            role,
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                firstName: true,
                lastName: true,
                isActive: true,
              },
            },
          },
        });

    return {
      id: member.id,
      tenantId: member.tenantId,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt.toISOString(),
      user: member.user,
    };
  }

  async removeAdminTenantMember(
    tenantId: number,
    userId: number,
  ): Promise<{ removed: true }> {
    const existing = await this.prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (!existing) {
      throw new NotFoundException('Thành viên không thuộc Tenant này');
    }
    await this.prisma.tenantMember.delete({ where: { id: existing.id } });
    return { removed: true };
  }

  // ==================== ADMIN: SUBSCRIPTIONS & USAGE ====================

  async assignAdminTenantSubscription(
    tenantId: number,
    body: {
      planId: number;
      billingCycle?: BillingCycleValue;
      startsAt?: string;
      expiresAt?: string | null;
      durationDays?: number | null;
      monthlyMinutesLimitOverride?: number | null;
      note?: string;
    },
  ): Promise<SubscriptionDto> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
    });
    if (!tenant) {
      throw new NotFoundException('Không tìm thấy Tenant');
    }

    const planId = Number(body?.planId);
    const plan = await this.prisma.plan.findFirst({
      where: { id: planId, deletedAt: null },
    });
    if (!plan) {
      throw new NotFoundException('Không tìm thấy gói dịch vụ');
    }

    const billingCycle: BillingCycleValue =
      body.billingCycle && BILLING_CYCLES.includes(body.billingCycle)
        ? body.billingCycle
        : 'MONTHLY';
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    if (Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException('startsAt không hợp lệ');
    }

    const expiresAt = resolveExpiresAt({
      expiresAt: body.expiresAt,
      durationDays: body.durationDays,
      billingCycle,
      startsAt,
      isFreePlan: plan.priceMonthly === 0 && plan.priceYearly === 0,
    });

    const override =
      body.monthlyMinutesLimitOverride === undefined ||
      body.monthlyMinutesLimitOverride === null
        ? null
        : Math.max(0, Math.round(Number(body.monthlyMinutesLimitOverride)));

    const sub = await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: { tenantId, status: 'ACTIVE' },
        data: { status: 'CANCELED' },
      });

      return tx.tenantSubscription.create({
        data: {
          tenantId,
          planId: plan.id,
          status: 'ACTIVE',
          billingCycle,
          startsAt,
          expiresAt,
          monthlyMinutesLimitOverride: override,
          note: body.note?.trim() || null,
        },
        include: { plan: true },
      });
    });

    return toSubscriptionDto(sub);
  }

  async resetAdminTenantUsage(
    tenantId: number,
    body?: { period?: string },
  ): Promise<QuotaDto> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!tenant) {
      throw new NotFoundException('Không tìm thấy Tenant');
    }

    const period =
      body?.period && /^\d{4}-\d{2}$/.test(body.period)
        ? body.period
        : currentBillingPeriod();

    await this.prisma.tenantUsageMonthly.upsert({
      where: { tenantId_period: { tenantId, period } },
      create: {
        tenantId,
        period,
        usedSeconds: 0,
        dubbedCues: 0,
        sessionsCount: 0,
      },
      update: {
        usedSeconds: 0,
      },
    });

    return computeQuota({
      tenantStatus: tenant.status,
      subscription: tenant.subscriptions[0] ?? null,
      usedSeconds: 0,
      period,
    });
  }

  // ==================== ADMIN: UPGRADE REQUESTS ====================

  async listAdminUpgradeRequests(query: {
    page?: unknown;
    limit?: unknown;
    status?: string;
  }): Promise<{ data: UpgradeRequestDto[]; pagination: PaginationType }> {
    const page = parsePositiveInt(query.page, 1, 10000);
    const limit = parsePositiveInt(query.limit, 20, 100);
    const where: Prisma.UpgradeRequestWhereInput = {};

    if (
      query.status &&
      UPGRADE_STATUSES.includes(query.status as UpgradeRequestStatusValue)
    ) {
      where.status = query.status as UpgradeRequestStatusValue;
    }

    const [total, rows] = await Promise.all([
      this.prisma.upgradeRequest.count({ where }),
      this.prisma.upgradeRequest.findMany({
        where,
        include: {
          tenant: true,
          requestedPlan: true,
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map(toUpgradeRequestDto),
      pagination: buildPagination(page, limit, total),
    };
  }

  async approveAdminUpgradeRequest(
    id: number,
    body?: {
      durationDays?: number;
      expiresAt?: string | null;
      monthlyMinutesLimitOverride?: number | null;
      adminNote?: string;
    },
  ): Promise<UpgradeRequestDto> {
    const existing = await this.prisma.upgradeRequest.findUnique({
      where: { id },
      include: { requestedPlan: true },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy yêu cầu nâng cấp');
    }
    if (existing.status !== 'PENDING') {
      throw new ConflictException('Yêu cầu nâng cấp này đã được xử lý');
    }

    const startsAt = new Date();
    const expiresAt = resolveExpiresAt({
      expiresAt: body?.expiresAt,
      durationDays: body?.durationDays,
      billingCycle: existing.billingCycle,
      startsAt,
      isFreePlan:
        existing.requestedPlan.priceMonthly === 0 &&
        existing.requestedPlan.priceYearly === 0,
    });
    const override =
      body?.monthlyMinutesLimitOverride === undefined ||
      body?.monthlyMinutesLimitOverride === null
        ? null
        : Math.max(0, Math.round(Number(body.monthlyMinutesLimitOverride)));

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.updateMany({
        where: { tenantId: existing.tenantId, status: 'ACTIVE' },
        data: { status: 'CANCELED' },
      });

      await tx.tenantSubscription.create({
        data: {
          tenantId: existing.tenantId,
          planId: existing.requestedPlanId,
          status: 'ACTIVE',
          billingCycle: existing.billingCycle,
          startsAt,
          expiresAt,
          monthlyMinutesLimitOverride: override,
          note:
            body?.adminNote?.trim() ||
            `Duyệt yêu cầu nâng cấp #${existing.id}`,
        },
      });

      return tx.upgradeRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          adminNote: body?.adminNote?.trim() || null,
          resolvedAt: new Date(),
        },
        include: {
          tenant: true,
          requestedPlan: true,
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      });
    });

    return toUpgradeRequestDto(updated);
  }

  async rejectAdminUpgradeRequest(
    id: number,
    body?: { adminNote?: string },
  ): Promise<UpgradeRequestDto> {
    const existing = await this.prisma.upgradeRequest.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy yêu cầu nâng cấp');
    }
    if (existing.status !== 'PENDING') {
      throw new ConflictException('Yêu cầu nâng cấp này đã được xử lý');
    }

    const updated = await this.prisma.upgradeRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        adminNote: body?.adminNote?.trim() || null,
        resolvedAt: new Date(),
      },
      include: {
        tenant: true,
        requestedPlan: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return toUpgradeRequestDto(updated);
  }

  // ==================== ADMIN: USERS ====================

  async listAdminUsers(query: {
    page?: unknown;
    limit?: unknown;
    search?: string;
  }): Promise<{ data: UserSummaryDto[]; pagination: PaginationType }> {
    const page = parsePositiveInt(query.page, 1, 10000);
    const limit = parsePositiveInt(query.limit, 20, 100);
    const search = query.search?.trim();

    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          isActive: true,
          isRoot: true,
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: users,
      pagination: buildPagination(page, limit, total),
    };
  }
}
