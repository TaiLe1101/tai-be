import {
  type ExecutionContext,
  Module,
  UnauthorizedException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '~/common/decorators/public.decorator';
import { HttpExceptionFilter } from '~/filters/http-exception.filter';
import { AuthController } from '~/modules/auth/auth.controller';
import { AuthService } from '~/modules/auth/auth.service';
import { PermissionsGuard } from '~/modules/auth/guards/permissions.guard';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { RedisService } from '~/modules/redis/redis.service';
import { AdminSaasController } from './admin-saas.controller';
import { AdminSaasGuard } from './guards/admin-saas.guard';
import { PublicPlansController } from './public-plans.controller';
import { SaasEntitlementService } from './saas-entitlement.service';
import { SaasMeController } from './saas-me.controller';
import { DEFAULT_SAAS_PLANS, SaasSeedService } from './saas-seed.service';
import { SaasService } from './saas.service';
import { computeQuota, currentBillingPeriod } from './saas.types';

interface PlanRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
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
}

interface UserRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  isActive: boolean;
  isRoot: boolean;
  username: string;
  email: string | null;
  password: string;
  avatar: string | null;
  firstName: string;
  lastName: string;
  phoneNumber: string | null;
  dateOfBirth: Date | null;
}

interface TenantRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  code: string;
  name: string;
  type: 'PERSONAL' | 'ORGANIZATION';
  status: 'ACTIVE' | 'SUSPENDED';
  contactEmail: string | null;
  notes: string | null;
}

interface MemberRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  tenantId: number;
  userId: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

interface SubscriptionRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  tenantId: number;
  planId: number;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELED' | 'PENDING';
  billingCycle: 'MONTHLY' | 'YEARLY' | 'LIFETIME';
  startsAt: Date;
  expiresAt: Date | null;
  monthlyMinutesLimitOverride: number | null;
  note: string | null;
}

interface UsageRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  tenantId: number;
  period: string;
  usedSeconds: number;
  dubbedCues: number;
  sessionsCount: number;
}

interface UpgradeRequestRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  tenantId: number;
  userId: number;
  requestedPlanId: number;
  billingCycle: 'MONTHLY' | 'YEARLY' | 'LIFETIME';
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  contactNote: string | null;
  adminNote: string | null;
  resolvedAt: Date | null;
}

function createInMemoryPrisma() {
  let seq = 1;
  const users: UserRow[] = [];
  const plans: PlanRow[] = [];
  const tenants: TenantRow[] = [];
  const members: MemberRow[] = [];
  const subscriptions: SubscriptionRow[] = [];
  const usages: UsageRow[] = [];
  const upgradeRequests: UpgradeRequestRow[] = [];

  const attachSubPlan = (s: SubscriptionRow) => ({
    ...s,
    plan: plans.find((p) => p.id === s.planId)!,
  });

  const attachUpgradeRelations = (r: UpgradeRequestRow) => ({
    ...r,
    tenant: tenants.find((t) => t.id === r.tenantId)!,
    requestedPlan: plans.find((p) => p.id === r.requestedPlanId)!,
    user: (() => {
      const u = users.find((x) => x.id === r.userId)!;
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
      };
    })(),
  });

  const prismaMock: Record<string, unknown> = {
    _state: { users, plans, tenants, members, subscriptions, usages, upgradeRequests },
    $transaction: async <T>(fn: (tx: typeof prismaMock) => Promise<T>): Promise<T> =>
      fn(prismaMock),

    user: {
      findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        return (
          users.find((u) => {
            if (where?.deletedAt === null && u.deletedAt !== null) return false;
            if (where?.id !== undefined && u.id !== where.id) return false;
            if (Array.isArray(where?.OR)) {
              return (where.OR as Record<string, unknown>[]).some((cond) => {
                if (typeof cond.username === 'string') return u.username === cond.username;
                if (cond.username && typeof cond.username === 'object') {
                  const eq = (cond.username as { equals?: string }).equals;
                  if (eq) return u.username.toLowerCase() === eq.toLowerCase();
                }
                if (cond.email && typeof cond.email === 'object') {
                  const eq = (cond.email as { equals?: string }).equals;
                  if (eq) return (u.email ?? '').toLowerCase() === eq.toLowerCase();
                }
                return false;
              });
            }
            return true;
          }) ?? null
        );
      }),
      findUnique: jest.fn(async ({ where, include }: { where: { id?: number; username?: string }; include?: unknown }) => {
        const found = users.find(
          (u) =>
            (where.id !== undefined && u.id === where.id) ||
            (where.username !== undefined && u.username === where.username),
        );
        if (!found) return null;
        return include ? { ...found, userRoles: [] } : found;
      }),
      create: jest.fn(async ({ data }: { data: Partial<UserRow> }) => {
        const now = new Date();
        const row: UserRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          isActive: data.isActive ?? true,
          isRoot: data.isRoot ?? false,
          username: data.username!,
          email: data.email ?? null,
          password: data.password!,
          avatar: null,
          firstName: data.firstName!,
          lastName: data.lastName ?? '',
          phoneNumber: null,
          dateOfBirth: null,
        };
        users.push(row);
        return row;
      }),
      count: jest.fn(async () => users.filter((u) => !u.deletedAt).length),
      findMany: jest.fn(async () => users.filter((u) => !u.deletedAt)),
    },

    permission: {
      findMany: jest.fn(async () => []),
    },

    plan: {
      count: jest.fn(async () => plans.filter((p) => !p.deletedAt).length),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { code: string };
          create: Partial<PlanRow>;
        }) => {
          const existing = plans.find((p) => p.code === where.code);
          if (existing) return existing;
          const now = new Date();
          const row: PlanRow = {
            id: seq++,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            code: create.code!,
            name: create.name!,
            description: create.description ?? null,
            badge: create.badge ?? null,
            priceMonthly: create.priceMonthly ?? 0,
            priceYearly: create.priceYearly ?? 0,
            currency: create.currency ?? 'VND',
            monthlyMinutesLimit: create.monthlyMinutesLimit ?? null,
            maxSeats: create.maxSeats ?? 1,
            features: create.features ?? [],
            isPublic: create.isPublic ?? true,
            isDefault: create.isDefault ?? false,
            isHighlighted: create.isHighlighted ?? false,
            sortOrder: create.sortOrder ?? 0,
            isActive: create.isActive ?? true,
          };
          plans.push(row);
          return row;
        },
      ),
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return plans
          .filter((p) => {
            if (where?.deletedAt === null && p.deletedAt !== null) return false;
            if (where?.isActive !== undefined && p.isActive !== where.isActive) return false;
            if (where?.isPublic !== undefined && p.isPublic !== where.isPublic) return false;
            return true;
          })
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
      }),
      findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return (
          plans.find((p) => {
            if (where?.deletedAt === null && p.deletedAt !== null) return false;
            if (where?.id !== undefined && p.id !== where.id) return false;
            if (where?.isActive !== undefined && p.isActive !== where.isActive) return false;
            if (where?.isDefault !== undefined && p.isDefault !== where.isDefault) return false;
            return true;
          }) ?? null
        );
      }),
      findUnique: jest.fn(async ({ where }: { where: { code?: string; id?: number } }) => {
        return (
          plans.find(
            (p) =>
              (where.code !== undefined && p.code === where.code) ||
              (where.id !== undefined && p.id === where.id),
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: { data: Partial<PlanRow> }) => {
        const now = new Date();
        const row: PlanRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          code: data.code!,
          name: data.name!,
          description: data.description ?? null,
          badge: data.badge ?? null,
          priceMonthly: data.priceMonthly ?? 0,
          priceYearly: data.priceYearly ?? 0,
          currency: data.currency ?? 'VND',
          monthlyMinutesLimit: data.monthlyMinutesLimit ?? null,
          maxSeats: data.maxSeats ?? 1,
          features: data.features ?? [],
          isPublic: data.isPublic ?? true,
          isDefault: data.isDefault ?? false,
          isHighlighted: data.isHighlighted ?? false,
          sortOrder: data.sortOrder ?? 0,
          isActive: data.isActive ?? true,
        };
        plans.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: number }; data: Partial<PlanRow> }) => {
        const target = plans.find((p) => p.id === where.id)!;
        Object.assign(target, data, { updatedAt: new Date() });
        return target;
      }),
      updateMany: jest.fn(async ({ where, data }: { where?: Record<string, unknown>; data: Partial<PlanRow> }) => {
        let count = 0;
        for (const p of plans) {
          if (where?.isDefault !== undefined && p.isDefault !== where.isDefault) continue;
          const notId = (where?.id as { not?: number } | undefined)?.not;
          if (notId !== undefined && p.id === notId) continue;
          Object.assign(p, data);
          count++;
        }
        return { count };
      }),
    },

    tenant: {
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return tenants.filter((t) => {
          if (where?.deletedAt === null && t.deletedAt !== null) return false;
          if (where?.status !== undefined && t.status !== where.status) return false;
          return true;
        }).length;
      }),
      findUnique: jest.fn(async ({ where }: { where: { code?: string; id?: number } }) => {
        return (
          tenants.find(
            (t) =>
              (where.code !== undefined && t.code === where.code) ||
              (where.id !== undefined && t.id === where.id),
          ) ?? null
        );
      }),
      findFirst: jest.fn(async ({ where }: { where: { id?: number } }) => {
        const t = tenants.find((x) => x.id === where.id && !x.deletedAt);
        if (!t) return null;
        return {
          ...t,
          _count: { members: members.filter((m) => m.tenantId === t.id).length },
          members: members
            .filter((m) => m.tenantId === t.id)
            .map((m) => {
              const u = users.find((x) => x.id === m.userId)!;
              return {
                ...m,
                user: {
                  id: u.id,
                  username: u.username,
                  email: u.email,
                  firstName: u.firstName,
                  lastName: u.lastName,
                  isActive: u.isActive,
                },
              };
            }),
          subscriptions: subscriptions
            .filter((s) => s.tenantId === t.id)
            .sort((a, b) => b.id - a.id)
            .map(attachSubPlan),
          monthlyUsages: usages.filter((u) => u.tenantId === t.id),
          upgradeRequests: upgradeRequests
            .filter((r) => r.tenantId === t.id)
            .map(attachUpgradeRelations),
        };
      }),
      findMany: jest.fn(async () => {
        return tenants
          .filter((t) => !t.deletedAt)
          .map((t) => ({
            ...t,
            _count: { members: members.filter((m) => m.tenantId === t.id).length },
            subscriptions: subscriptions
              .filter((s) => s.tenantId === t.id && s.status === 'ACTIVE')
              .map(attachSubPlan),
            monthlyUsages: usages.filter(
              (u) => u.tenantId === t.id && u.period === currentBillingPeriod(),
            ),
          }));
      }),
      create: jest.fn(async ({ data }: { data: Partial<TenantRow> }) => {
        const now = new Date();
        const row: TenantRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          code: data.code!,
          name: data.name!,
          type: data.type ?? 'PERSONAL',
          status: data.status ?? 'ACTIVE',
          contactEmail: data.contactEmail ?? null,
          notes: data.notes ?? null,
        };
        tenants.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: number }; data: Partial<TenantRow> }) => {
        const target = tenants.find((t) => t.id === where.id)!;
        Object.assign(target, data, { updatedAt: new Date() });
        return target;
      }),
    },

    tenantMember: {
      findMany: jest.fn(async ({ where }: { where: { userId?: number } }) => {
        return members
          .filter((m) => m.userId === where.userId)
          .map((m) => {
            const tenant = tenants.find((t) => t.id === m.tenantId)!;
            return {
              ...m,
              tenant: {
                ...tenant,
                subscriptions: subscriptions
                  .filter((s) => s.tenantId === tenant.id)
                  .sort((a, b) => b.id - a.id)
                  .map(attachSubPlan),
              },
            };
          });
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { tenantId_userId: { tenantId: number; userId: number } } }) => {
          return (
            members.find(
              (m) =>
                m.tenantId === where.tenantId_userId.tenantId &&
                m.userId === where.tenantId_userId.userId,
            ) ?? null
          );
        },
      ),
      create: jest.fn(async ({ data }: { data: Partial<MemberRow> }) => {
        const now = new Date();
        const row: MemberRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          tenantId: data.tenantId!,
          userId: data.userId!,
          role: data.role ?? 'MEMBER',
        };
        members.push(row);
        const u = users.find((x) => x.id === row.userId);
        return u
          ? {
              ...row,
              user: {
                id: u.id,
                username: u.username,
                email: u.email,
                firstName: u.firstName,
                lastName: u.lastName,
                isActive: u.isActive,
              },
            }
          : row;
      }),
      delete: jest.fn(async ({ where }: { where: { id: number } }) => {
        const idx = members.findIndex((m) => m.id === where.id);
        if (idx >= 0) members.splice(idx, 1);
      }),
    },

    tenantSubscription: {
      count: jest.fn(async ({ where }: { where?: { planId?: number; status?: string } }) => {
        return subscriptions.filter(
          (s) =>
            (where?.planId === undefined || s.planId === where.planId) &&
            (where?.status === undefined || s.status === where.status),
        ).length;
      }),
      findMany: jest.fn(async ({ where }: { where?: { status?: string } }) => {
        return subscriptions
          .filter((s) => !where?.status || s.status === where.status)
          .map(attachSubPlan);
      }),
      create: jest.fn(async ({ data }: { data: Partial<SubscriptionRow> }) => {
        const now = new Date();
        const row: SubscriptionRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          tenantId: data.tenantId!,
          planId: data.planId!,
          status: data.status ?? 'ACTIVE',
          billingCycle: data.billingCycle ?? 'MONTHLY',
          startsAt: data.startsAt ?? now,
          expiresAt: data.expiresAt ?? null,
          monthlyMinutesLimitOverride: data.monthlyMinutesLimitOverride ?? null,
          note: data.note ?? null,
        };
        subscriptions.push(row);
        return attachSubPlan(row);
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { tenantId?: number; status?: string };
          data: Partial<SubscriptionRow>;
        }) => {
          let count = 0;
          for (const s of subscriptions) {
            if (where.tenantId !== undefined && s.tenantId !== where.tenantId) continue;
            if (where.status !== undefined && s.status !== where.status) continue;
            Object.assign(s, data);
            count++;
          }
          return { count };
        },
      ),
    },

    tenantUsageMonthly: {
      findUnique: jest.fn(
        async ({ where }: { where: { tenantId_period: { tenantId: number; period: string } } }) => {
          return (
            usages.find(
              (u) =>
                u.tenantId === where.tenantId_period.tenantId &&
                u.period === where.tenantId_period.period,
            ) ?? null
          );
        },
      ),
      aggregate: jest.fn(async ({ where }: { where?: { period?: string } }) => {
        const sum = usages
          .filter((u) => !where?.period || u.period === where.period)
          .reduce((acc, u) => acc + u.usedSeconds, 0);
        return { _sum: { usedSeconds: sum } };
      }),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { tenantId_period: { tenantId: number; period: string } };
          create: Partial<UsageRow>;
          update: Record<string, unknown>;
        }) => {
          let row = usages.find(
            (u) =>
              u.tenantId === where.tenantId_period.tenantId &&
              u.period === where.tenantId_period.period,
          );
          if (!row) {
            const now = new Date();
            row = {
              id: seq++,
              createdAt: now,
              updatedAt: now,
              tenantId: create.tenantId!,
              period: create.period!,
              usedSeconds: create.usedSeconds ?? 0,
              dubbedCues: create.dubbedCues ?? 0,
              sessionsCount: create.sessionsCount ?? 0,
            };
            usages.push(row);
            return row;
          }
          if (typeof update.usedSeconds === 'number') {
            row.usedSeconds = update.usedSeconds;
          } else if (
            update.usedSeconds &&
            typeof (update.usedSeconds as { increment?: number }).increment === 'number'
          ) {
            row.usedSeconds += (update.usedSeconds as { increment: number }).increment;
          }
          if (
            update.dubbedCues &&
            typeof (update.dubbedCues as { increment?: number }).increment === 'number'
          ) {
            row.dubbedCues += (update.dubbedCues as { increment: number }).increment;
          }
          if (
            update.sessionsCount &&
            typeof (update.sessionsCount as { increment?: number }).increment === 'number'
          ) {
            row.sessionsCount += (update.sessionsCount as { increment: number }).increment;
          }
          return row;
        },
      ),
    },

    upgradeRequest: {
      count: jest.fn(async ({ where }: { where?: { status?: string } } = {}) => {
        return upgradeRequests.filter(
          (r) => !where?.status || r.status === where.status,
        ).length;
      }),
      findMany: jest.fn(async ({ where }: { where?: { tenantId?: number; status?: string } } = {}) => {
        return upgradeRequests
          .filter(
            (r) =>
              (where?.tenantId === undefined || r.tenantId === where.tenantId) &&
              (where?.status === undefined || r.status === where.status),
          )
          .map(attachUpgradeRelations);
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: number } }) => {
        const found = upgradeRequests.find((r) => r.id === where.id);
        return found ? attachUpgradeRelations(found) : null;
      }),
      create: jest.fn(async ({ data }: { data: Partial<UpgradeRequestRow> }) => {
        const now = new Date();
        const row: UpgradeRequestRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          tenantId: data.tenantId!,
          userId: data.userId!,
          requestedPlanId: data.requestedPlanId!,
          billingCycle: data.billingCycle ?? 'MONTHLY',
          status: data.status ?? 'PENDING',
          contactNote: data.contactNote ?? null,
          adminNote: data.adminNote ?? null,
          resolvedAt: null,
        };
        upgradeRequests.push(row);
        return attachUpgradeRelations(row);
      }),
      update: jest.fn(async ({ where, data }: { where: { id: number }; data: Partial<UpgradeRequestRow> }) => {
        const target = upgradeRequests.find((r) => r.id === where.id)!;
        Object.assign(target, data, { updatedAt: new Date() });
        return attachUpgradeRelations(target);
      }),
    },
  };

  return prismaMock;
}

class MockJwtGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolveUser: (token: string) => Record<string, unknown> | null,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: Record<string, unknown>;
    }>();
    const header = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = token ? this.resolveUser(token) : null;
    if (!user) throw new UnauthorizedException('Unauthorized');
    req.user = user;
    return true;
  }
}

describe('TAI SaaS Module (Auth + Public Plans + Entitlement + Quota + Admin)', () => {
  let app: NestExpressApplication;
  let prismaMock: ReturnType<typeof createInMemoryPrisma>;
  let entitlementService: SaasEntitlementService;
  const redisStore = new Map<string, unknown>();

  const redisMock = {
    get: jest.fn(async <T>(key: string): Promise<T | null> =>
      redisStore.has(key) ? (redisStore.get(key) as T) : null,
    ),
    set: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
  };

  let registeredUserId = 0;

  beforeEach(async () => {
    redisStore.clear();
    prismaMock = createInMemoryPrisma();
    registeredUserId = 0;

    @Module({
      imports: [
        JwtModule.register({
          secret: 'saas-test-secret',
        }),
      ],
      controllers: [
        AuthController,
        PublicPlansController,
        SaasMeController,
        AdminSaasController,
      ],
      providers: [
        AuthService,
        SaasSeedService,
        SaasEntitlementService,
        SaasService,
        AdminSaasGuard,
        { provide: PrismaService, useValue: prismaMock },
        { provide: RedisService, useValue: redisMock },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => 4) },
        },
      ],
    })
    class SaasTestModule {}

    app = await NestFactory.create<NestExpressApplication>(SaasTestModule, {
      logger: false,
    });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    const reflector = app.get(Reflector);
    app.useGlobalGuards(
      new MockJwtGuard(reflector, (token) => {
        if (token === 'root-token') {
          return { id: 999, username: 'root', isRoot: true, permissions: [] };
        }
        if (token === 'user-token' && registeredUserId > 0) {
          return {
            id: registeredUserId,
            username: 'alice@example.com',
            isRoot: false,
            permissions: [],
          };
        }
        return null;
      }),
      new PermissionsGuard(reflector),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    entitlementService = app.get(SaasEntitlementService);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/v1/public/plans auto-bootstraps 3 default Vietnamese plans with public CORS', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/public/plans')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const body = res.body as { status: string; data: Array<{ code: string; isDefault: boolean; monthlyMinutesLimit: number | null }> };
    expect(body.status).toBe('success');
    expect(body.data.map((p) => p.code)).toEqual(['free', 'pro', 'team']);
    expect(body.data[0].isDefault).toBe(true);
    expect(body.data[0].monthlyMinutesLimit).toBe(DEFAULT_SAAS_PLANS[0].monthlyMinutesLimit);
  });

  it('POST /api/v1/auth/app/register creates user, personal tenant, Free subscription, and supports email/username login', async () => {
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/app/register')
      .send({
        email: 'Alice@Example.com',
        password: 'Password123',
        firstName: 'Alice',
        lastName: 'Nguyen',
        tenantName: 'Alice Space',
      })
      .expect(201);

    const regData = (reg.body as {
      data: {
        accessToken: string;
        refreshToken: string;
        user: { id: number; email: string; username: string };
        entitlement: {
          tenant: { name: string; type: string };
          memberRole: string;
          plan: { code: string };
          quota: { limitMinutes: number; canDub: boolean };
        };
      };
    }).data;

    registeredUserId = regData.user.id;
    expect(regData.accessToken).toBeTruthy();
    expect(regData.refreshToken).toBeTruthy();
    expect(regData.user.email).toBe('alice@example.com');
    expect(regData.entitlement.tenant).toMatchObject({
      name: 'Alice Space',
      type: 'PERSONAL',
    });
    expect(regData.entitlement.memberRole).toBe('OWNER');
    expect(regData.entitlement.plan.code).toBe('free');
    expect(regData.entitlement.quota).toMatchObject({
      limitMinutes: 60,
      canDub: true,
    });

    // Duplicate email returns 409
    await request(app.getHttpServer())
      .post('/api/v1/auth/app/register')
      .send({
        email: 'alice@example.com',
        password: 'Password123',
        firstName: 'Alice2',
      })
      .expect(409);

    // Login using email inside username field
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/app/login')
      .send({
        username: 'ALICE@example.com',
        password: 'Password123',
      })
      .expect(201);

    expect(
      (login.body as { data: { user: { id: number }; entitlement: { plan: { code: string } } } })
        .data.entitlement.plan.code,
    ).toBe('free');

    // GET /api/v1/auth/me includes email & entitlement
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer user-token')
      .expect(200);
    expect(
      (me.body as { data: { profile: { email: string }; entitlement: { plan: { code: string } } } })
        .data.profile.email,
    ).toBe('alice@example.com');
    expect(
      (me.body as { data: { entitlement: { plan: { code: string } } } }).data
        .entitlement.plan.code,
    ).toBe('free');
  });

  it('enforces QUOTA_EXCEEDED, SUBSCRIPTION_EXPIRED, TENANT_SUSPENDED, and root bypass', async () => {
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/app/register')
      .send({
        email: 'quota@example.com',
        password: 'Password123',
        firstName: 'Quota',
      })
      .expect(201);
    const userId = (reg.body as { data: { user: { id: number } } }).data.user.id;

    // Allowed initially
    await expect(
      entitlementService.assertCanDub({ id: userId, isRoot: false }),
    ).resolves.toBeTruthy();

    // Record 3600s (60 min) -> hits Free plan limit
    const updatedQuota = await entitlementService.recordDubbingUsage(
      { id: userId, isRoot: false },
      [{ watchedSeconds: 3600, dubbedCues: 100 }],
    );
    expect(updatedQuota.canDub).toBe(false);
    expect(updatedQuota.blockReason).toBe('QUOTA_EXCEEDED');

    await expect(
      entitlementService.assertCanDub({ id: userId, isRoot: false }),
    ).rejects.toMatchObject({ status: 402 });

    // Root user always bypasses
    await expect(
      entitlementService.assertCanDub({ id: userId, isRoot: true }),
    ).resolves.toBeTruthy();

    // Pure computeQuota checks for expired & suspended
    const expired = computeQuota({
      tenantStatus: 'ACTIVE',
      subscription: {
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 10_000),
        monthlyMinutesLimitOverride: null,
        plan: { monthlyMinutesLimit: 600 },
      },
      usedSeconds: 10,
    });
    expect(expired.blockReason).toBe('SUBSCRIPTION_EXPIRED');
    expect(expired.canDub).toBe(false);

    const suspended = computeQuota({
      tenantStatus: 'SUSPENDED',
      subscription: {
        status: 'ACTIVE',
        expiresAt: null,
        monthlyMinutesLimitOverride: null,
        plan: { monthlyMinutesLimit: null },
      },
      usedSeconds: 0,
    });
    expect(suspended.blockReason).toBe('TENANT_SUSPENDED');
    expect(suspended.canDub).toBe(false);
  });

  it('supports desktop upgrade requests and Admin SaaS CRUD, approval, plan delete guard, and usage reset', async () => {
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/app/register')
      .send({
        email: 'alice@example.com',
        password: 'Password123',
        firstName: 'Alice',
      })
      .expect(201);
    const regData = (reg.body as {
      data: {
        user: { id: number };
        entitlement: { tenant: { id: number } };
      };
    }).data;
    registeredUserId = regData.user.id;
    const tenantId = regData.entitlement.tenant.id;

    // Regular desktop user blocked from /admin/saas/*
    await request(app.getHttpServer())
      .get('/api/v1/admin/saas/overview')
      .set('Authorization', 'Bearer user-token')
      .expect(403);

    // Admin lists plans
    const plansRes = await request(app.getHttpServer())
      .get('/api/v1/admin/saas/plans')
      .set('Authorization', 'Bearer root-token')
      .expect(200);
    const plans = (plansRes.body as { data: Array<{ id: number; code: string }> }).data;
    const freePlan = plans.find((p) => p.code === 'free')!;
    const proPlan = plans.find((p) => p.code === 'pro')!;

    // Cannot delete free plan while active subscription exists -> 409
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/saas/plans/${freePlan.id}`)
      .set('Authorization', 'Bearer root-token')
      .expect(409);

    // Desktop user creates upgrade request for Pro
    const reqCreate = await request(app.getHttpServer())
      .post('/api/v1/saas/me/upgrade-requests')
      .set('Authorization', 'Bearer user-token')
      .send({
        planId: proPlan.id,
        billingCycle: 'YEARLY',
        contactNote: 'Zalo 0901234567',
      })
      .expect(201);
    const upgradeReqId = (reqCreate.body as { data: { id: number; status: string } }).data.id;

    // Admin approves upgrade request -> activates Pro subscription
    const approveRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/saas/upgrade-requests/${upgradeReqId}/approve`)
      .set('Authorization', 'Bearer root-token')
      .send({ durationDays: 365, adminNote: 'Đã xác nhận chuyển khoản' })
      .expect(200);
    expect(
      (approveRes.body as { data: { status: string } }).data.status,
    ).toBe('APPROVED');

    // Desktop user entitlement now reflects Pro plan!
    const entRes = await request(app.getHttpServer())
      .get('/api/v1/saas/me/entitlement')
      .set('Authorization', 'Bearer user-token')
      .expect(200);
    expect(
      (entRes.body as { data: { plan: { code: string }; quota: { limitMinutes: number } } })
        .data,
    ).toMatchObject({
      plan: { code: 'pro' },
      quota: { limitMinutes: 600 },
    });

    // Record usage then reset via Admin
    await entitlementService.recordDubbingUsage(
      { id: registeredUserId, isRoot: false },
      [{ watchedSeconds: 900, dubbedCues: 25 }],
    );
    const resetRes = await request(app.getHttpServer())
      .put(`/api/v1/admin/saas/tenants/${tenantId}/usage/reset`)
      .set('Authorization', 'Bearer root-token')
      .send({})
      .expect(200);
    expect((resetRes.body as { data: { usedSeconds: number } }).data.usedSeconds).toBe(0);

    // Admin creates custom plan and soft-deletes it
    const customPlan = await request(app.getHttpServer())
      .post('/api/v1/admin/saas/plans')
      .set('Authorization', 'Bearer root-token')
      .send({
        code: 'enterprise',
        name: 'Enterprise',
        priceMonthly: 999000,
        priceYearly: 9990000,
        monthlyMinutesLimit: null,
        maxSeats: 20,
        features: ['Không giới hạn phút'],
      })
      .expect(201);
    const entPlanId = (customPlan.body as { data: { id: number } }).data.id;

    await request(app.getHttpServer())
      .delete(`/api/v1/admin/saas/plans/${entPlanId}`)
      .set('Authorization', 'Bearer root-token')
      .expect(200);

    // Overview returns expected KPIs
    const overview = await request(app.getHttpServer())
      .get('/api/v1/admin/saas/overview')
      .set('Authorization', 'Bearer root-token')
      .expect(200);
    expect((overview.body as { data: { totalTenants: number; activeSubscriptions: number } }).data).toMatchObject({
      totalTenants: 1,
      activeSubscriptions: 1,
    });
  });
});
