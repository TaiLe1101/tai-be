import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '$/prisma/client';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { SaasEntitlementService } from '~/modules/saas/saas-entitlement.service';
import type { PaginationType } from '~/types/pagination.type';
import { SepayApiClient } from './sepay-api.client';
import type {
  PaymentConfigDto,
  PaymentOrderDto,
  PaymentOrderStatusDto,
  PaymentOrderStatusValue,
  PaymentPaidSourceValue,
  SepayApiTransactionItem,
  SepayEventStatusValue,
  SepayOrderReconcileResultDto,
  SepayReconcileRunResultDto,
  SepayReconcileSummaryDto,
  SepayWebhookEventAdminDto,
  SepayWebhookPayload,
} from './sepay-payments.types';
import {
  buildTransferContent,
  formatVietnamTimestamp,
  generatePaymentCode,
  isPrismaUniqueViolation,
  isSameBankTransfer,
  maskAccountNumber,
  normalizeOptionalField,
  parseVietnamTransactionDate,
  toPaymentOrderDto,
  toPaymentOrderStatusDto,
  toSepayWebhookEventAdminDto,
  verifySepayWebhookAuth,
} from './sepay.utils';

const ORDER_STATUSES: PaymentOrderStatusValue[] = [
  'PENDING',
  'PAID',
  'EXPIRED',
  'CANCELED',
];
const EVENT_STATUSES: SepayEventStatusValue[] = [
  'RECEIVED',
  'PROCESSED',
  'UNMATCHED',
  'FAILED',
];
const MAX_CODE_COLLISION_RETRIES = 6;
const DEFAULT_FIRST_RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface NormalizedIncomingTransfer {
  source: PaymentPaidSourceValue;
  gateway: string;
  accountNumber: string;
  subAccount: string | null;
  code: string | null;
  transferType: string;
  amount: number;
  transactionDate: string;
  transactionDateUtc: Date | null;
  referenceCode: string | null;
  webhookId?: bigint;
  apiTxId?: string;
}

interface TransferApplyOutcome {
  status: 'PROCESSED' | 'UNMATCHED';
  verdict: boolean;
  unmatchedReason: string | null;
  orderId: number | null;
  paymentCode: string | null;
  newlyPaid: boolean;
}

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

@Injectable()
export class SepayPaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SepayPaymentsService.name);
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private reconcileRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly entitlementService: SaasEntitlementService,
    private readonly sepayApiClient: SepayApiClient,
  ) {}

  onModuleInit(): void {
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    if (nodeEnv === 'test' || !this.sepayApiClient.isConfigured) {
      return;
    }

    const intervalMinutes = Number(
      this.configService.get<number>('SEPAY_RECONCILE_INTERVAL_MINUTES') || 20,
    );
    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    this.reconcileTimer = setInterval(() => {
      void this.runRoutineReconciliation().catch(() => {
        this.logger.warn('Scheduled SePay reconciliation cycle failed');
      });
    }, intervalMs);
    this.reconcileTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
    }
  }

  // ==================== CONFIG HELPERS ====================

  private get bankCode(): string {
    return (this.configService.get<string>('SEPAY_BANK_CODE') || '').trim();
  }

  private get accountNumber(): string {
    return (
      this.configService.get<string>('SEPAY_ACCOUNT_NUMBER') || ''
    ).trim();
  }

  private get accountName(): string {
    return (this.configService.get<string>('SEPAY_ACCOUNT_NAME') || '').trim();
  }

  private get paymentCodePrefix(): string {
    return (
      this.configService.get<string>('SEPAY_PAYMENT_CODE_PREFIX') || 'TAI'
    ).trim();
  }

  private get desPrefix(): string {
    return (this.configService.get<string>('SEPAY_DES_PREFIX') || '').trim();
  }

  private get orderTtlMinutes(): number {
    const raw = Number(
      this.configService.get<number>('SEPAY_ORDER_TTL_MINUTES') || 15,
    );
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15;
  }

  private get webhookAuthMode(): 'hmac' | 'apikey' {
    return this.configService.get<string>('SEPAY_WEBHOOK_AUTH_MODE') === 'apikey'
      ? 'apikey'
      : 'hmac';
  }

  private get webhookSecret(): string {
    return (this.configService.get<string>('SEPAY_WEBHOOK_SECRET') || '').trim();
  }

  private isSepayCheckoutEnabled(): boolean {
    return Boolean(
      this.bankCode &&
        this.accountNumber &&
        this.accountName &&
        this.webhookSecret,
    );
  }

  // ==================== DESKTOP USER ENDPOINTS ====================

  getPaymentConfig(): PaymentConfigDto {
    const enabled = this.isSepayCheckoutEnabled();
    return {
      sepayEnabled: enabled,
      bankCode: enabled ? this.bankCode : null,
      accountName: enabled ? this.accountName : null,
      orderTtlMinutes: this.orderTtlMinutes,
    };
  }

  async createOrder(
    userId: number,
    body: { planId?: number; billingCycle?: 'MONTHLY' | 'YEARLY' },
  ): Promise<PaymentOrderDto> {
    if (!this.isSepayCheckoutEnabled()) {
      throw new ServiceUnavailableException(
        'Thanh toán tự động SePay chưa được cấu hình trên máy chủ',
      );
    }

    const planId = Number(body?.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      throw new BadRequestException('planId không hợp lệ');
    }

    const billingCycle: 'MONTHLY' | 'YEARLY' =
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

    const amount =
      billingCycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException(
        'Chỉ hỗ trợ tạo mã VietQR cho gói trả phí có số tiền lớn hơn 0 VND',
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.orderTtlMinutes * 60_000);

    for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRIES; attempt++) {
      const paymentCode = generatePaymentCode(this.paymentCodePrefix);
      const transferContent = buildTransferContent(this.desPrefix, paymentCode);

      try {
        const order = await this.prisma.paymentOrder.create({
          data: {
            paymentCode,
            tenantId: entitlement.tenant.id,
            userId,
            planId: plan.id,
            billingCycle,
            amount,
            currency: plan.currency || 'VND',
            status: 'PENDING',
            bankCode: this.bankCode,
            accountNumber: this.accountNumber,
            accountName: this.accountName,
            transferContent,
            expiresAt,
          },
          include: {
            plan: { select: { id: true, code: true, name: true } },
            tenant: { select: { id: true, code: true, name: true } },
          },
        });

        this.logger.log(
          `Created payment order orderCode=${order.paymentCode} amount=${order.amount} status=${order.status} account=${maskAccountNumber(order.accountNumber)}`,
        );

        return toPaymentOrderDto(order, now);
      } catch (error) {
        if (isPrismaUniqueViolation(error) && attempt < MAX_CODE_COLLISION_RETRIES - 1) {
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException(
      'Không thể tạo mã thanh toán duy nhất, vui lòng thử lại',
    );
  }

  async listTenantOrders(userId: number): Promise<PaymentOrderDto[]> {
    const entitlement = await this.entitlementService.getUserEntitlement(
      userId,
      { createIfMissing: true },
    );
    if (!entitlement) return [];

    const now = new Date();
    const orders = await this.prisma.paymentOrder.findMany({
      where: { tenantId: entitlement.tenant.id },
      include: {
        plan: { select: { id: true, code: true, name: true } },
        tenant: { select: { id: true, code: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    return orders.map((order) => toPaymentOrderDto(order, now));
  }

  async getTenantOrderStatus(
    userId: number,
    paymentCode: string,
  ): Promise<PaymentOrderStatusDto> {
    const entitlement = await this.entitlementService.getUserEntitlement(
      userId,
      { createIfMissing: true },
    );
    if (!entitlement) {
      throw new NotFoundException('Không tìm thấy đơn thanh toán');
    }

    const code = paymentCode.trim();
    const order = await this.prisma.paymentOrder.findFirst({
      where: {
        paymentCode: { equals: code, mode: 'insensitive' },
        tenantId: entitlement.tenant.id,
      },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn thanh toán');
    }

    const now = new Date();
    if (order.status === 'PENDING' && order.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.paymentOrder.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      return toPaymentOrderStatusDto({ ...order, status: 'EXPIRED' }, now);
    }

    return toPaymentOrderStatusDto(order, now);
  }

  async cancelTenantOrder(
    userId: number,
    paymentCode: string,
  ): Promise<PaymentOrderStatusDto> {
    const entitlement = await this.entitlementService.getUserEntitlement(
      userId,
      { createIfMissing: true },
    );
    if (!entitlement) {
      throw new NotFoundException('Không tìm thấy đơn thanh toán');
    }

    const code = paymentCode.trim();
    const order = await this.prisma.paymentOrder.findFirst({
      where: {
        paymentCode: { equals: code, mode: 'insensitive' },
        tenantId: entitlement.tenant.id,
      },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn thanh toán');
    }

    if (order.status === 'PENDING') {
      const updated = await this.prisma.paymentOrder.updateMany({
        where: {
          id: order.id,
          tenantId: entitlement.tenant.id,
          status: 'PENDING',
        },
        data: { status: 'CANCELED' },
      });
      if (updated.count === 1) {
        this.logger.log(
          `Canceled payment order orderCode=${order.paymentCode} status=CANCELED`,
        );
        return toPaymentOrderStatusDto({ ...order, status: 'CANCELED' });
      }
      const reloaded = await this.prisma.paymentOrder.findUnique({
        where: { id: order.id },
      });
      if (reloaded) {
        return toPaymentOrderStatusDto(reloaded);
      }
    }

    return toPaymentOrderStatusDto(order);
  }

  // ==================== WEBHOOK AUTH & PROCESSING ====================

  verifyWebhookRequest(params: {
    timestampHeader?: string;
    signatureHeader?: string;
    authorizationHeader?: string;
    rawBody?: Buffer;
  }): boolean {
    return verifySepayWebhookAuth({
      mode: this.webhookAuthMode,
      secret: this.webhookSecret,
      timestampHeader: params.timestampHeader,
      signatureHeader: params.signatureHeader,
      authorizationHeader: params.authorizationHeader,
      rawBody: params.rawBody,
    });
  }

  async handleWebhook(
    payload: SepayWebhookPayload,
  ): Promise<{ success: boolean }> {
    const webhookId = this.parseWebhookId(payload?.id);
    if (webhookId === null) {
      return { success: false };
    }

    const gateway = String(payload.gateway ?? '').trim();
    const transactionDate = String(payload.transactionDate ?? '').trim();
    const transactionDateUtc = parseVietnamTransactionDate(transactionDate);
    const accountNumber = String(payload.accountNumber ?? '').trim();
    const subAccount = normalizeOptionalField(payload.subAccount);
    const code = normalizeOptionalField(payload.code);
    const transferType = String(payload.transferType ?? '')
      .trim()
      .toLowerCase();
    const rawAmount = Number(payload.transferAmount);
    const transferAmount =
      Number.isInteger(rawAmount) && rawAmount > 0 ? rawAmount : 0;
    const rawAccumulated = Number(payload.accumulated);
    const accumulated = Number.isFinite(rawAccumulated)
      ? Math.trunc(rawAccumulated)
      : 0;
    const referenceCode = normalizeOptionalField(payload.referenceCode);

    // 1. Atomic UNIQUE insert (never SELECT-then-INSERT) so duplicate deliveries collapse cleanly.
    let eventRowId: number;
    try {
      const inserted = await this.prisma.sepayWebhookEvent.create({
        data: {
          sepayWebhookId: webhookId,
          gateway,
          transactionDate,
          transactionDateUtc,
          accountNumber,
          subAccount,
          code,
          transferType,
          transferAmount,
          accumulated,
          referenceCode,
          rawPayload: payload as unknown as Prisma.InputJsonValue,
          status: 'RECEIVED',
          verdict: false,
        },
      });
      eventRowId = inserted.id;
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) {
        // DB error before storing event -> let 500 bubble so SePay retries!
        throw error;
      }

      const existing = await this.prisma.sepayWebhookEvent.findUnique({
        where: { sepayWebhookId: webhookId },
      });
      if (!existing) {
        throw error;
      }
      if (existing.status !== 'RECEIVED') {
        this.logger.log(
          `Replayed SePay webhook eventId=${String(webhookId)} orderCode=${existing.paymentCode ?? existing.code ?? '-'} amount=${existing.transferAmount} status=${existing.status} verdict=${existing.verdict} account=${maskAccountNumber(existing.accountNumber)}`,
        );
        return { success: existing.verdict };
      }
      eventRowId = existing.id;
    }

    // 2. Evaluate and run atomic conditional fulfillment.
    const outcome = await this.applyTransferToOrder({
      source: 'WEBHOOK',
      gateway,
      accountNumber,
      subAccount,
      code,
      transferType,
      amount: transferAmount,
      transactionDate,
      transactionDateUtc,
      referenceCode,
      webhookId,
    });

    await this.prisma.sepayWebhookEvent.update({
      where: { id: eventRowId },
      data: {
        status: outcome.status,
        verdict: outcome.verdict,
        unmatchedReason: outcome.unmatchedReason,
        orderId: outcome.orderId,
        paymentCode: outcome.paymentCode,
      },
    });

    // Strict Decree 13/2023 privacy log: identifiers + masked account ONLY (no memos/names/signatures).
    this.logger.log(
      `Processed SePay webhook eventId=${String(webhookId)} orderCode=${outcome.paymentCode ?? code ?? '-'} amount=${transferAmount} status=${outcome.status} verdict=${outcome.verdict} account=${maskAccountNumber(accountNumber)}`,
    );

    return { success: outcome.verdict };
  }

  // ==================== SHARED ATOMIC ORDER FULFILLMENT ====================

  private async applyTransferToOrder(
    transfer: NormalizedIncomingTransfer,
  ): Promise<TransferApplyOutcome> {
    if (transfer.transferType !== 'in') {
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'NON_INCOMING_TRANSFER',
        orderId: null,
        paymentCode: transfer.code,
        newlyPaid: false,
      };
    }

    if (transfer.amount <= 0) {
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'INVALID_AMOUNT',
        orderId: null,
        paymentCode: transfer.code,
        newlyPaid: false,
      };
    }

    const expectedAccount = this.accountNumber;
    if (
      expectedAccount &&
      transfer.accountNumber !== expectedAccount &&
      transfer.subAccount !== expectedAccount
    ) {
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'ACCOUNT_MISMATCH',
        orderId: null,
        paymentCode: transfer.code,
        newlyPaid: false,
      };
    }

    // Match strictly by SePay-extracted `code` (case-insensitive). Never regex-parse content or match by amount+time.
    if (!transfer.code) {
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'EMPTY_CODE',
        orderId: null,
        paymentCode: null,
        newlyPaid: false,
      };
    }

    const order = await this.prisma.paymentOrder.findFirst({
      where: {
        paymentCode: { equals: transfer.code, mode: 'insensitive' },
      },
    });

    if (!order) {
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'ORDER_NOT_FOUND',
        orderId: null,
        paymentCode: transfer.code,
        newlyPaid: false,
      };
    }

    // Already PAID: compare transfer tuple for cross-source dedup (webhook <-> reconciliation).
    if (order.status === 'PAID') {
      if (isSameBankTransfer(order, transfer)) {
        if (transfer.webhookId !== undefined && order.paidWebhookId === null) {
          await this.prisma.paymentOrder.updateMany({
            where: { id: order.id, paidWebhookId: null },
            data: { paidWebhookId: transfer.webhookId },
          });
        } else if (transfer.apiTxId && !order.paidApiTxId) {
          await this.prisma.paymentOrder.updateMany({
            where: { id: order.id, paidApiTxId: null },
            data: { paidApiTxId: transfer.apiTxId },
          });
        }
        return {
          status: 'PROCESSED',
          verdict: true,
          unmatchedReason: null,
          orderId: order.id,
          paymentCode: order.paymentCode,
          newlyPaid: false,
        };
      }

      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'SECOND_PAYMENT',
        orderId: order.id,
        paymentCode: order.paymentCode,
        newlyPaid: false,
      };
    }

    // Late payment after CANCELED / EXPIRED (using Asia/Ho_Chi_Minh transactionDate vs order.expiresAt)
    const effectiveTxTime = transfer.transactionDateUtc ?? new Date();
    if (order.status === 'CANCELED') {
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'ORDER_CANCELED',
        orderId: order.id,
        paymentCode: order.paymentCode,
        newlyPaid: false,
      };
    }

    if (
      order.status === 'EXPIRED' ||
      effectiveTxTime.getTime() > order.expiresAt.getTime()
    ) {
      if (order.status === 'PENDING') {
        await this.prisma.paymentOrder.updateMany({
          where: { id: order.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
      }
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason: 'ORDER_EXPIRED',
        orderId: order.id,
        paymentCode: order.paymentCode,
        newlyPaid: false,
      };
    }

    // Exact amount match ONLY (integer VND)
    if (transfer.amount !== order.amount) {
      return {
        status: 'UNMATCHED',
        verdict: false,
        unmatchedReason:
          transfer.amount < order.amount ? 'UNDERPAID' : 'OVERPAID',
        orderId: order.id,
        paymentCode: order.paymentCode,
        newlyPaid: false,
      };
    }

    // Atomic conditional paid transition + subscription activation in ONE transaction.
    const won = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.paymentOrder.updateMany({
        where: {
          id: order.id,
          status: 'PENDING',
          amount: transfer.amount,
        },
        data: {
          status: 'PAID',
          paidAt: now,
          paidAmount: transfer.amount,
          paidSource: transfer.source,
          paidReferenceCode: transfer.referenceCode,
          paidTransactionDate: transfer.transactionDate,
          paidAccountNumber: transfer.accountNumber,
          ...(transfer.webhookId !== undefined
            ? { paidWebhookId: transfer.webhookId }
            : {}),
          ...(transfer.apiTxId !== undefined
            ? { paidApiTxId: transfer.apiTxId }
            : {}),
        },
      });

      if (updated.count !== 1) {
        return false;
      }

      const durationDays = order.billingCycle === 'YEARLY' ? 365 : 30;
      const existingActiveSubs = await tx.tenantSubscription.findMany({
        where: { tenantId: order.tenantId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });

      const currentSamePlan = existingActiveSubs.find(
        (sub) =>
          sub.planId === order.planId &&
          sub.expiresAt !== null &&
          sub.expiresAt.getTime() > now.getTime(),
      );
      const baseTime = currentSamePlan?.expiresAt
        ? currentSamePlan.expiresAt.getTime()
        : now.getTime();
      const expiresAt = new Date(baseTime + durationDays * 86_400_000);

      await tx.tenantSubscription.updateMany({
        where: { tenantId: order.tenantId, status: 'ACTIVE' },
        data: { status: 'CANCELED' },
      });

      const activated = await tx.tenantSubscription.create({
        data: {
          tenantId: order.tenantId,
          planId: order.planId,
          status: 'ACTIVE',
          billingCycle: order.billingCycle,
          startsAt: now,
          expiresAt,
          note: `Thanh toán tự động SePay (${order.paymentCode})`,
        },
      });

      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { activatedSubscriptionId: activated.id },
      });

      return true;
    });

    if (won) {
      return {
        status: 'PROCESSED',
        verdict: true,
        unmatchedReason: null,
        orderId: order.id,
        paymentCode: order.paymentCode,
        newlyPaid: true,
      };
    }

    // Lost a concurrent race: reload order to distinguish same-transfer vs second payment.
    const reloaded = await this.prisma.paymentOrder.findUnique({
      where: { id: order.id },
    });
    if (reloaded?.status === 'PAID' && isSameBankTransfer(reloaded, transfer)) {
      return {
        status: 'PROCESSED',
        verdict: true,
        unmatchedReason: null,
        orderId: order.id,
        paymentCode: order.paymentCode,
        newlyPaid: false,
      };
    }

    return {
      status: 'UNMATCHED',
      verdict: false,
      unmatchedReason:
        reloaded?.status === 'PAID' ? 'SECOND_PAYMENT' : 'ORDER_NOT_PENDING',
      orderId: order.id,
      paymentCode: order.paymentCode,
      newlyPaid: false,
    };
  }

  // ==================== RECONCILIATION (SEPAY API V2) ====================

  async runRoutineReconciliation(): Promise<SepayReconcileRunResultDto> {
    if (this.reconcileRunning) {
      throw new ConflictException('Đang chạy một phiên đối soát SePay khác');
    }
    this.reconcileRunning = true;

    try {
      const state = await this.prisma.sepayReconcileState.findUnique({
        where: { id: 1 },
      });

      const lookbackFrom = formatVietnamTimestamp(
        new Date(Date.now() - DEFAULT_FIRST_RECONCILE_LOOKBACK_MS),
      );
      const rows = await this.sepayApiClient.listTransactionsSince({
        sinceId: state?.lastCursorId ?? null,
        transactionDateFrom: state?.lastCursorId ? undefined : lookbackFrom,
        perPage: 100,
      });

      let matched = 0;
      let unmatched = 0;
      let alreadyHandled = 0;
      let lastCursorId = state?.lastCursorId ?? null;

      for (const row of rows) {
        if (row.id) {
          lastCursorId = String(row.id);
        }
        const result = await this.processApiTransactionRow(row);
        if (result === 'ALREADY_HANDLED') {
          alreadyHandled += 1;
        } else if (result === 'MATCHED') {
          matched += 1;
        } else if (result === 'UNMATCHED') {
          unmatched += 1;
        }
      }

      const now = new Date();
      await this.prisma.sepayReconcileState.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          lastRunAt: now,
          lastCursorId,
          lastFetchedCount: rows.length,
          lastMatchedCount: matched,
          lastUnmatchedCount: unmatched,
        },
        update: {
          lastRunAt: now,
          lastCursorId,
          lastFetchedCount: rows.length,
          lastMatchedCount: matched,
          lastUnmatchedCount: unmatched,
        },
      });

      this.logger.log(
        `Completed SePay reconciliation fetched=${rows.length} matched=${matched} unmatched=${unmatched} alreadyHandled=${alreadyHandled}`,
      );

      return {
        fetched: rows.length,
        matched,
        unmatched,
        alreadyHandled,
        cursorId: lastCursorId,
      };
    } finally {
      this.reconcileRunning = false;
    }
  }

  async reconcileOrderById(
    orderId: number,
  ): Promise<SepayOrderReconcileResultDto> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id: orderId },
      include: {
        plan: { select: { id: true, code: true, name: true } },
        tenant: { select: { id: true, code: true, name: true } },
      },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn thanh toán');
    }

    const fromStr = formatVietnamTimestamp(
      new Date(order.createdAt.getTime() - 5 * 60_000),
    );
    const rows = await this.sepayApiClient.searchTransactionsByQuery({
      q: order.paymentCode,
      transactionDateFrom: fromStr,
    });

    // `q` is a substring search: strictly filter to exact case-insensitive `code` match!
    const exactRows = rows.filter((row) => {
      const rowCode = normalizeOptionalField(row.code);
      return (
        rowCode !== null &&
        rowCode.toLowerCase() === order.paymentCode.toLowerCase()
      );
    });

    let matched = false;
    for (const row of exactRows) {
      const result = await this.processApiTransactionRow(row);
      if (result === 'MATCHED') {
        matched = true;
      }
    }

    const reloaded = await this.prisma.paymentOrder.findUnique({
      where: { id: order.id },
      include: {
        plan: { select: { id: true, code: true, name: true } },
        tenant: { select: { id: true, code: true, name: true } },
      },
    });

    return {
      matched: matched || reloaded?.status === 'PAID',
      order: toPaymentOrderDto(reloaded ?? order),
      checkedTransactions: exactRows.length,
    };
  }

  private async processApiTransactionRow(
    row: SepayApiTransactionItem,
  ): Promise<'MATCHED' | 'UNMATCHED' | 'ALREADY_HANDLED' | 'IGNORED'> {
    const apiTxId = String(row.id ?? '').trim();
    if (!apiTxId) return 'IGNORED';

    const amountIn = Number(row.amount_in ?? 0);
    const amountOut = Number(row.amount_out ?? 0);
    const transferType =
      String(row.transfer_type ?? '').trim().toLowerCase() ||
      (amountIn > 0 ? 'in' : amountOut > 0 ? 'out' : '');
    const amount =
      transferType === 'in' && Number.isInteger(amountIn) && amountIn > 0
        ? amountIn
        : 0;
    const transactionDate = String(row.transaction_date ?? '').trim();
    const transactionDateUtc = parseVietnamTransactionDate(transactionDate);
    const accountNumber = String(row.account_number ?? '').trim();
    const subAccount = normalizeOptionalField(row.sub_account ?? row.va);
    const code = normalizeOptionalField(row.code);
    const referenceNumber = normalizeOptionalField(row.reference_number);
    const bankBrandName = String(row.bank_brand_name ?? '').trim();

    let apiRowId: number;
    try {
      const inserted = await this.prisma.sepayApiTransaction.create({
        data: {
          sepayApiTxId: apiTxId,
          bankBrandName,
          accountNumber,
          subAccount,
          transactionDate,
          transactionDateUtc,
          transferType,
          amount,
          code,
          referenceNumber,
          rawPayload: row as unknown as Prisma.InputJsonValue,
          status: 'RECEIVED',
          verdict: false,
        },
      });
      apiRowId = inserted.id;
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.prisma.sepayApiTransaction.findUnique({
        where: { sepayApiTxId: apiTxId },
      });
      if (!existing || existing.status !== 'RECEIVED') {
        return 'ALREADY_HANDLED';
      }
      apiRowId = existing.id;
    }

    if (transferType !== 'in') {
      await this.prisma.sepayApiTransaction.update({
        where: { id: apiRowId },
        data: {
          status: 'PROCESSED',
          verdict: false,
          unmatchedReason: 'NON_INCOMING_TRANSFER',
        },
      });
      return 'IGNORED';
    }

    const outcome = await this.applyTransferToOrder({
      source: 'RECONCILIATION',
      gateway: bankBrandName,
      accountNumber,
      subAccount,
      code,
      transferType,
      amount,
      transactionDate,
      transactionDateUtc,
      referenceCode: referenceNumber,
      apiTxId,
    });

    await this.prisma.sepayApiTransaction.update({
      where: { id: apiRowId },
      data: {
        status: outcome.status,
        verdict: outcome.verdict,
        unmatchedReason: outcome.unmatchedReason,
        orderId: outcome.orderId,
        paymentCode: outcome.paymentCode,
      },
    });

    this.logger.log(
      `Reconciled SePay API tx eventId=${apiTxId} orderCode=${outcome.paymentCode ?? code ?? '-'} amount=${amount} status=${outcome.status} verdict=${outcome.verdict} account=${maskAccountNumber(accountNumber)}`,
    );

    return outcome.newlyPaid
      ? 'MATCHED'
      : outcome.status === 'UNMATCHED'
        ? 'UNMATCHED'
        : 'ALREADY_HANDLED';
  }

  // ==================== ADMIN ENDPOINTS ====================

  async getAdminSummary(): Promise<SepayReconcileSummaryDto> {
    const [state, pendingOrders, paidOrders, unmatchedWebhookEvents] =
      await Promise.all([
        this.prisma.sepayReconcileState.findUnique({ where: { id: 1 } }),
        this.prisma.paymentOrder.count({
          where: { status: 'PENDING', expiresAt: { gt: new Date() } },
        }),
        this.prisma.paymentOrder.count({ where: { status: 'PAID' } }),
        this.prisma.sepayWebhookEvent.count({ where: { status: 'UNMATCHED' } }),
      ]);

    return {
      enabled: this.isSepayCheckoutEnabled(),
      env: this.sepayApiClient.env,
      lastRunAt: state?.lastRunAt ? state.lastRunAt.toISOString() : null,
      lastCursorId: state?.lastCursorId ?? null,
      lastFetchedCount: state?.lastFetchedCount ?? 0,
      lastMatchedCount: state?.lastMatchedCount ?? 0,
      lastUnmatchedCount: state?.lastUnmatchedCount ?? 0,
      pendingOrders,
      paidOrders,
      unmatchedEvents: unmatchedWebhookEvents,
    };
  }

  async listAdminOrders(query: {
    page?: unknown;
    limit?: unknown;
    status?: string;
    search?: string;
  }): Promise<{ data: PaymentOrderDto[]; pagination: PaginationType }> {
    const page = parsePositiveInt(query.page, 1, 10000);
    const limit = parsePositiveInt(query.limit, 20, 100);
    const search = query.search?.trim();
    const now = new Date();

    const andConditions: Prisma.PaymentOrderWhereInput[] = [];
    if (
      query.status &&
      ORDER_STATUSES.includes(query.status as PaymentOrderStatusValue)
    ) {
      if (query.status === 'PENDING') {
        andConditions.push({ status: 'PENDING', expiresAt: { gt: now } });
      } else if (query.status === 'EXPIRED') {
        andConditions.push({
          OR: [
            { status: 'EXPIRED' },
            { status: 'PENDING', expiresAt: { lte: now } },
          ],
        });
      } else {
        andConditions.push({ status: query.status as PaymentOrderStatusValue });
      }
    }
    if (search) {
      andConditions.push({
        OR: [
          { paymentCode: { contains: search, mode: 'insensitive' } },
          { paidReferenceCode: { contains: search, mode: 'insensitive' } },
          { tenant: { name: { contains: search, mode: 'insensitive' } } },
          { tenant: { code: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }

    const where: Prisma.PaymentOrderWhereInput =
      andConditions.length > 0 ? { AND: andConditions } : {};

    const [total, orders] = await Promise.all([
      this.prisma.paymentOrder.count({ where }),
      this.prisma.paymentOrder.findMany({
        where,
        include: {
          plan: { select: { id: true, code: true, name: true } },
          tenant: { select: { id: true, code: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: orders.map((order) => toPaymentOrderDto(order, now)),
      pagination: buildPagination(page, limit, total),
    };
  }

  async cancelAdminOrder(id: number): Promise<PaymentOrderDto> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { id },
      include: {
        plan: { select: { id: true, code: true, name: true } },
        tenant: { select: { id: true, code: true, name: true } },
      },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn thanh toán');
    }

    if (order.status !== 'PENDING') {
      throw new ConflictException(
        'Chỉ có thể hủy đơn thanh toán ở trạng thái PENDING',
      );
    }

    const now = new Date();
    if (order.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.paymentOrder.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      throw new ConflictException(
        'Đơn thanh toán đã hết hạn, không thể hủy',
      );
    }

    const updated = await this.prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'CANCELED' },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Đơn thanh toán đã thay đổi trạng thái');
    }

    this.logger.log(
      `Admin canceled payment order orderCode=${order.paymentCode} status=CANCELED`,
    );

    return toPaymentOrderDto({ ...order, status: 'CANCELED' });
  }

  async listAdminEvents(query: {
    page?: unknown;
    limit?: unknown;
    status?: string;
    search?: string;
  }): Promise<{
    data: SepayWebhookEventAdminDto[];
    pagination: PaginationType;
  }> {
    const page = parsePositiveInt(query.page, 1, 10000);
    const limit = parsePositiveInt(query.limit, 20, 100);
    const search = query.search?.trim();

    const where: Prisma.SepayWebhookEventWhereInput = {};
    if (
      query.status &&
      EVENT_STATUSES.includes(query.status as SepayEventStatusValue)
    ) {
      where.status = query.status as SepayEventStatusValue;
    }
    if (search) {
      const orConditions: Prisma.SepayWebhookEventWhereInput[] = [
        { code: { contains: search, mode: 'insensitive' } },
        { paymentCode: { contains: search, mode: 'insensitive' } },
        { referenceCode: { contains: search, mode: 'insensitive' } },
        { gateway: { contains: search, mode: 'insensitive' } },
      ];
      if (/^\d+$/.test(search)) {
        orConditions.push({ sepayWebhookId: BigInt(search) });
      }
      where.OR = orConditions;
    }

    const [total, events] = await Promise.all([
      this.prisma.sepayWebhookEvent.count({ where }),
      this.prisma.sepayWebhookEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: events.map(toSepayWebhookEventAdminDto),
      pagination: buildPagination(page, limit, total),
    };
  }

  private parseWebhookId(raw: unknown): bigint | null {
    if (typeof raw === 'bigint') {
      return raw > 0n ? raw : null;
    }
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
      return BigInt(raw);
    }
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
      const parsed = BigInt(raw.trim());
      return parsed > 0n ? parsed : null;
    }
    return null;
  }
}
