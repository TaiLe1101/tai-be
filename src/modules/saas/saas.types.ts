export type TenantTypeValue = 'PERSONAL' | 'ORGANIZATION';
export type TenantStatusValue = 'ACTIVE' | 'SUSPENDED';
export type TenantMemberRoleValue = 'OWNER' | 'ADMIN' | 'MEMBER';
export type SubscriptionStatusValue = 'ACTIVE' | 'EXPIRED' | 'CANCELED' | 'PENDING';
export type BillingCycleValue = 'MONTHLY' | 'YEARLY' | 'LIFETIME';
export type UpgradeRequestStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED';
export type QuotaBlockReason =
  | 'TENANT_SUSPENDED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'QUOTA_EXCEEDED'
  | 'NO_SUBSCRIPTION'
  | null;

export interface PlanDto {
  id: number;
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

export interface TenantDto {
  id: number;
  code: string;
  name: string;
  type: TenantTypeValue;
  status: TenantStatusValue;
  contactEmail: string | null;
  notes: string | null;
  createdAt: string;
}

export interface SubscriptionDto {
  id: number;
  tenantId: number;
  planId: number;
  status: SubscriptionStatusValue;
  billingCycle: BillingCycleValue;
  startsAt: string;
  expiresAt: string | null;
  monthlyMinutesLimitOverride: number | null;
  note: string | null;
  plan: PlanDto;
}

export interface QuotaDto {
  period: string;
  usedSeconds: number;
  usedMinutes: number;
  limitMinutes: number | null;
  remainingMinutes: number | null;
  isUnlimited: boolean;
  canDub: boolean;
  blockReason: QuotaBlockReason;
}

export interface EntitlementDto {
  tenant: TenantDto;
  memberRole: TenantMemberRoleValue;
  subscription: SubscriptionDto | null;
  plan: PlanDto | null;
  quota: QuotaDto;
}

export interface UserSummaryDto {
  id: number;
  username: string;
  email: string | null;
  firstName: string;
  lastName: string;
  isActive: boolean;
  isRoot: boolean;
}

export interface TenantMemberDto {
  id: number;
  tenantId: number;
  userId: number;
  role: TenantMemberRoleValue;
  createdAt: string;
  user: {
    id: number;
    username: string;
    email: string | null;
    firstName: string;
    lastName: string;
    isActive: boolean;
  };
}

export interface UpgradeRequestDto {
  id: number;
  tenantId: number;
  userId: number;
  requestedPlanId: number;
  billingCycle: 'MONTHLY' | 'YEARLY';
  status: UpgradeRequestStatusValue;
  contactNote: string | null;
  adminNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  tenant?: TenantDto;
  requestedPlan?: PlanDto;
  user?: {
    id: number;
    username: string;
    email: string | null;
    firstName: string;
    lastName: string;
  };
}

export interface TenantUsageRecordDto {
  id: number;
  tenantId: number;
  period: string;
  usedSeconds: number;
  usedMinutes: number;
  dubbedCues: number;
  sessionsCount: number;
}

export interface TenantListItemDto extends TenantDto {
  memberCount: number;
  activeSubscription: SubscriptionDto | null;
  currentUsage: {
    period: string;
    usedSeconds: number;
    usedMinutes: number;
    limitMinutes: number | null;
  };
}

export interface TenantDetailDto extends TenantDto {
  members: TenantMemberDto[];
  subscriptions: SubscriptionDto[];
  usageHistory: TenantUsageRecordDto[];
  upgradeRequests: UpgradeRequestDto[];
  quota: QuotaDto;
}

export interface SaasOverviewDto {
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  totalUsers: number;
  activeSubscriptions: number;
  pendingUpgradeRequests: number;
  currentPeriod: string;
  totalUsedMinutesThisMonth: number;
  planDistribution: Array<{
    planId: number;
    code: string;
    name: string;
    count: number;
  }>;
}

export function currentBillingPeriod(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function secondsToMinutes(seconds: number): number {
  return Math.round((Math.max(0, seconds) / 60) * 100) / 100;
}

export function toPlanDto(plan: {
  id: number;
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
}): PlanDto {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    badge: plan.badge,
    priceMonthly: plan.priceMonthly,
    priceYearly: plan.priceYearly,
    currency: plan.currency,
    monthlyMinutesLimit: plan.monthlyMinutesLimit,
    maxSeats: plan.maxSeats,
    features: Array.isArray(plan.features) ? plan.features : [],
    isPublic: plan.isPublic,
    isDefault: plan.isDefault,
    isHighlighted: plan.isHighlighted,
    sortOrder: plan.sortOrder,
    isActive: plan.isActive,
  };
}

export function toTenantDto(tenant: {
  id: number;
  code: string;
  name: string;
  type: TenantTypeValue;
  status: TenantStatusValue;
  contactEmail: string | null;
  notes: string | null;
  createdAt: Date | string;
}): TenantDto {
  return {
    id: tenant.id,
    code: tenant.code,
    name: tenant.name,
    type: tenant.type,
    status: tenant.status,
    contactEmail: tenant.contactEmail,
    notes: tenant.notes,
    createdAt:
      tenant.createdAt instanceof Date
        ? tenant.createdAt.toISOString()
        : String(tenant.createdAt),
  };
}

export function toSubscriptionDto(sub: {
  id: number;
  tenantId: number;
  planId: number;
  status: SubscriptionStatusValue;
  billingCycle: BillingCycleValue;
  startsAt: Date | string;
  expiresAt: Date | string | null;
  monthlyMinutesLimitOverride: number | null;
  note: string | null;
  plan: Parameters<typeof toPlanDto>[0];
}): SubscriptionDto {
  return {
    id: sub.id,
    tenantId: sub.tenantId,
    planId: sub.planId,
    status: sub.status,
    billingCycle: sub.billingCycle,
    startsAt:
      sub.startsAt instanceof Date
        ? sub.startsAt.toISOString()
        : String(sub.startsAt),
    expiresAt:
      sub.expiresAt === null
        ? null
        : sub.expiresAt instanceof Date
          ? sub.expiresAt.toISOString()
          : String(sub.expiresAt),
    monthlyMinutesLimitOverride: sub.monthlyMinutesLimitOverride,
    note: sub.note,
    plan: toPlanDto(sub.plan),
  };
}

export function computeQuota(params: {
  tenantStatus: TenantStatusValue;
  subscription: {
    status: SubscriptionStatusValue;
    expiresAt: Date | string | null;
    monthlyMinutesLimitOverride: number | null;
    plan: { monthlyMinutesLimit: number | null };
  } | null;
  usedSeconds: number;
  period?: string;
  now?: Date;
}): QuotaDto {
  const now = params.now ?? new Date();
  const period = params.period ?? currentBillingPeriod(now);
  const usedSeconds = Math.max(0, Math.round(params.usedSeconds || 0));
  const usedMinutes = secondsToMinutes(usedSeconds);
  const sub = params.subscription;

  const effectiveLimitMinutes = sub
    ? sub.monthlyMinutesLimitOverride !== null &&
      sub.monthlyMinutesLimitOverride !== undefined
      ? sub.monthlyMinutesLimitOverride
      : sub.plan.monthlyMinutesLimit
    : null;

  const isUnlimited = Boolean(sub && effectiveLimitMinutes === null);
  const remainingMinutes = !sub
    ? 0
    : isUnlimited
      ? null
      : Math.max(
          0,
          Math.round(((effectiveLimitMinutes as number) - usedSeconds / 60) * 100) /
            100,
        );

  let blockReason: QuotaBlockReason = null;
  if (params.tenantStatus === 'SUSPENDED') {
    blockReason = 'TENANT_SUSPENDED';
  } else if (!sub || sub.status === 'CANCELED' || sub.status === 'PENDING') {
    blockReason = 'NO_SUBSCRIPTION';
  } else if (
    sub.status === 'EXPIRED' ||
    (sub.expiresAt !== null && new Date(sub.expiresAt).getTime() <= now.getTime())
  ) {
    blockReason = 'SUBSCRIPTION_EXPIRED';
  } else if (
    !isUnlimited &&
    effectiveLimitMinutes !== null &&
    usedSeconds >= effectiveLimitMinutes * 60
  ) {
    blockReason = 'QUOTA_EXCEEDED';
  }

  return {
    period,
    usedSeconds,
    usedMinutes,
    limitMinutes: effectiveLimitMinutes,
    remainingMinutes,
    isUnlimited,
    canDub: blockReason === null,
    blockReason,
  };
}

export function toUpgradeRequestDto(req: {
  id: number;
  tenantId: number;
  userId: number;
  requestedPlanId: number;
  billingCycle: BillingCycleValue;
  status: UpgradeRequestStatusValue;
  contactNote: string | null;
  adminNote: string | null;
  createdAt: Date | string;
  resolvedAt: Date | string | null;
  tenant?: Parameters<typeof toTenantDto>[0] | null;
  requestedPlan?: Parameters<typeof toPlanDto>[0] | null;
  user?: {
    id: number;
    username: string;
    email: string | null;
    firstName: string;
    lastName: string;
  } | null;
}): UpgradeRequestDto {
  return {
    id: req.id,
    tenantId: req.tenantId,
    userId: req.userId,
    requestedPlanId: req.requestedPlanId,
    billingCycle: req.billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY',
    status: req.status,
    contactNote: req.contactNote,
    adminNote: req.adminNote,
    createdAt:
      req.createdAt instanceof Date
        ? req.createdAt.toISOString()
        : String(req.createdAt),
    resolvedAt:
      req.resolvedAt === null
        ? null
        : req.resolvedAt instanceof Date
          ? req.resolvedAt.toISOString()
          : String(req.resolvedAt),
    ...(req.tenant ? { tenant: toTenantDto(req.tenant) } : {}),
    ...(req.requestedPlan
      ? { requestedPlan: toPlanDto(req.requestedPlan) }
      : {}),
    ...(req.user ? { user: req.user } : {}),
  };
}
