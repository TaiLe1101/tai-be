import { HttpService } from '@nestjs/axios';
import {
  type ExecutionContext,
  Module,
  UnauthorizedException,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import { createHmac } from 'node:crypto';
import { of } from 'rxjs';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '~/common/decorators/public.decorator';
import { HttpExceptionFilter } from '~/filters/http-exception.filter';
import { PermissionsGuard } from '~/modules/auth/guards/permissions.guard';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { AdminSaasGuard } from '~/modules/saas/guards/admin-saas.guard';
import { SaasEntitlementService } from '~/modules/saas/saas-entitlement.service';
import { AdminSaasPaymentsController } from './admin-saas-payments.controller';
import { SaasPaymentsMeController } from './saas-payments-me.controller';
import { SepayApiClient } from './sepay-api.client';
import { SepayPaymentsService } from './sepay-payments.service';
import { SepayWebhookController } from './sepay-webhook.controller';
import { formatVietnamTimestamp, maskAccountNumber } from './sepay.utils';

const TEST_WEBHOOK_SECRET = 'sepay-unit-test-hmac-secret-key';
const TEST_BANK_CODE = 'MBBank';
const TEST_ACCOUNT_NUMBER = '09876543217890';
const TEST_ACCOUNT_NAME = 'CONG TY TAI';

function signWebhookBody(rawBody: string, secret: string, timestampSec: number) {
  const hex = createHmac('sha256', secret)
    .update(`${timestampSec}.${rawBody}`)
    .digest('hex');
  return {
    timestamp: String(timestampSec),
    signature: `sha256=${hex}`,
  };
}

interface OrderRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  paymentCode: string;
  tenantId: number;
  userId: number;
  planId: number;
  billingCycle: 'MONTHLY' | 'YEARLY' | 'LIFETIME';
  amount: number;
  currency: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELED';
  bankCode: string;
  accountNumber: string;
  accountName: string;
  transferContent: string;
  expiresAt: Date;
  paidAt: Date | null;
  paidAmount: number | null;
  paidSource: 'WEBHOOK' | 'RECONCILIATION' | null;
  paidReferenceCode: string | null;
  paidTransactionDate: string | null;
  paidAccountNumber: string | null;
  paidWebhookId: bigint | null;
  paidApiTxId: string | null;
  activatedSubscriptionId: number | null;
}

interface WebhookEventRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  sepayWebhookId: bigint;
  gateway: string;
  transactionDate: string;
  transactionDateUtc: Date | null;
  accountNumber: string;
  subAccount: string | null;
  code: string | null;
  transferType: string;
  transferAmount: number;
  accumulated: number;
  referenceCode: string | null;
  rawPayload: unknown;
  status: 'RECEIVED' | 'PROCESSED' | 'UNMATCHED' | 'FAILED';
  verdict: boolean;
  unmatchedReason: string | null;
  orderId: number | null;
  paymentCode: string | null;
}

interface ApiTxRow {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  sepayApiTxId: string;
  bankBrandName: string;
  accountNumber: string;
  subAccount: string | null;
  transactionDate: string;
  transactionDateUtc: Date | null;
  transferType: string;
  amount: number;
  code: string | null;
  referenceNumber: string | null;
  rawPayload: unknown;
  status: 'RECEIVED' | 'PROCESSED' | 'UNMATCHED' | 'FAILED';
  verdict: boolean;
  unmatchedReason: string | null;
  orderId: number | null;
  paymentCode: string | null;
}

interface SubscriptionRow {
  id: number;
  createdAt: Date;
  tenantId: number;
  planId: number;
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELED' | 'PENDING';
  billingCycle: 'MONTHLY' | 'YEARLY' | 'LIFETIME';
  startsAt: Date;
  expiresAt: Date | null;
  note: string | null;
}

function createInMemoryPaymentsPrisma() {
  let seq = 1;
  const plans = [
    {
      id: 1,
      code: 'free',
      name: 'Miễn phí',
      priceMonthly: 0,
      priceYearly: 0,
      currency: 'VND',
      isActive: true,
      deletedAt: null,
    },
    {
      id: 2,
      code: 'pro',
      name: 'Pro',
      priceMonthly: 99000,
      priceYearly: 950000,
      currency: 'VND',
      isActive: true,
      deletedAt: null,
    },
  ];
  const tenants = [{ id: 10, code: 'alice-space', name: 'Alice Space' }];
  const orders: OrderRow[] = [];
  const webhookEvents: WebhookEventRow[] = [];
  const apiTransactions: ApiTxRow[] = [];
  const subscriptions: SubscriptionRow[] = [];
  let reconcileState: {
    id: number;
    updatedAt: Date;
    lastRunAt: Date | null;
    lastCursorId: string | null;
    lastFetchedCount: number;
    lastMatchedCount: number;
    lastUnmatchedCount: number;
  } | null = null;

  const attachOrderRelations = (o: OrderRow) => ({
    ...o,
    plan: plans.find((p) => p.id === o.planId) ?? null,
    tenant: tenants.find((t) => t.id === o.tenantId) ?? null,
  });

  const prismaMock: Record<string, unknown> = {
    _state: {
      plans,
      tenants,
      orders,
      webhookEvents,
      apiTransactions,
      subscriptions,
      getReconcileState: () => reconcileState,
    },
    $transaction: async <T>(fn: (tx: typeof prismaMock) => Promise<T>): Promise<T> =>
      fn(prismaMock),

    plan: {
      findFirst: jest.fn(async ({ where }: { where?: { id?: number } }) => {
        return plans.find((p) => p.id === where?.id && p.isActive && !p.deletedAt) ?? null;
      }),
    },

    paymentOrder: {
      create: jest.fn(async ({ data }: { data: Partial<OrderRow> }) => {
        if (orders.some((o) => o.paymentCode === data.paymentCode)) {
          const err = new Error('Unique constraint failed') as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        const now = new Date();
        const row: OrderRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          paymentCode: data.paymentCode!,
          tenantId: data.tenantId!,
          userId: data.userId!,
          planId: data.planId!,
          billingCycle: data.billingCycle ?? 'MONTHLY',
          amount: data.amount!,
          currency: data.currency ?? 'VND',
          status: data.status ?? 'PENDING',
          bankCode: data.bankCode!,
          accountNumber: data.accountNumber!,
          accountName: data.accountName!,
          transferContent: data.transferContent!,
          expiresAt: data.expiresAt!,
          paidAt: null,
          paidAmount: null,
          paidSource: null,
          paidReferenceCode: null,
          paidTransactionDate: null,
          paidAccountNumber: null,
          paidWebhookId: null,
          paidApiTxId: null,
          activatedSubscriptionId: null,
        };
        orders.push(row);
        return attachOrderRelations(row);
      }),
      findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return orders
          .filter((o) => {
            if (where?.tenantId !== undefined && o.tenantId !== where.tenantId) return false;
            if (where?.status !== undefined && o.status !== where.status) return false;
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(attachOrderRelations);
      }),
      findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        const found = orders.find((o) => {
          if (where?.tenantId !== undefined && o.tenantId !== where.tenantId) return false;
          if (where?.paymentCode) {
            const pc = where.paymentCode as string | { equals?: string };
            const target = typeof pc === 'string' ? pc : (pc.equals ?? '');
            if (o.paymentCode.toLowerCase() !== target.toLowerCase()) return false;
          }
          return true;
        });
        return found ? attachOrderRelations(found) : null;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id?: number } }) => {
        const found = orders.find((o) => o.id === where.id);
        return found ? attachOrderRelations(found) : null;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<OrderRow>;
        }) => {
          let count = 0;
          for (const o of orders) {
            if (where.id !== undefined && o.id !== where.id) continue;
            if (where.tenantId !== undefined && o.tenantId !== where.tenantId) continue;
            if (where.status !== undefined && o.status !== where.status) continue;
            if (where.amount !== undefined && o.amount !== where.amount) continue;
            if (where.paidWebhookId === null && o.paidWebhookId !== null) continue;
            if (where.paidApiTxId === null && o.paidApiTxId !== null) continue;
            Object.assign(o, data, { updatedAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: number }; data: Partial<OrderRow> }) => {
          const target = orders.find((o) => o.id === where.id)!;
          Object.assign(target, data, { updatedAt: new Date() });
          return attachOrderRelations(target);
        },
      ),
      count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return orders.filter((o) => {
          if (where?.status !== undefined && o.status !== where.status) return false;
          if (where?.expiresAt && typeof where.expiresAt === 'object') {
            const gt = (where.expiresAt as { gt?: Date }).gt;
            if (gt && o.expiresAt.getTime() <= gt.getTime()) return false;
          }
          return true;
        }).length;
      }),
    },

    sepayWebhookEvent: {
      create: jest.fn(async ({ data }: { data: Partial<WebhookEventRow> }) => {
        if (webhookEvents.some((e) => e.sepayWebhookId === data.sepayWebhookId)) {
          const err = new Error('Unique constraint failed') as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        const now = new Date();
        const row: WebhookEventRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          sepayWebhookId: data.sepayWebhookId!,
          gateway: data.gateway ?? '',
          transactionDate: data.transactionDate ?? '',
          transactionDateUtc: data.transactionDateUtc ?? null,
          accountNumber: data.accountNumber ?? '',
          subAccount: data.subAccount ?? null,
          code: data.code ?? null,
          transferType: data.transferType ?? '',
          transferAmount: data.transferAmount ?? 0,
          accumulated: data.accumulated ?? 0,
          referenceCode: data.referenceCode ?? null,
          rawPayload: data.rawPayload ?? {},
          status: data.status ?? 'RECEIVED',
          verdict: data.verdict ?? false,
          unmatchedReason: data.unmatchedReason ?? null,
          orderId: data.orderId ?? null,
          paymentCode: data.paymentCode ?? null,
        };
        webhookEvents.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { sepayWebhookId: bigint } }) => {
        return webhookEvents.find((e) => e.sepayWebhookId === where.sepayWebhookId) ?? null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: number }; data: Partial<WebhookEventRow> }) => {
          const target = webhookEvents.find((e) => e.id === where.id)!;
          Object.assign(target, data, { updatedAt: new Date() });
          return target;
        },
      ),
      count: jest.fn(async ({ where }: { where?: { status?: string } } = {}) => {
        return webhookEvents.filter((e) => !where?.status || e.status === where.status).length;
      }),
      findMany: jest.fn(async ({ where }: { where?: { status?: string } } = {}) => {
        return webhookEvents
          .filter((e) => !where?.status || e.status === where.status)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }),
    },

    sepayApiTransaction: {
      create: jest.fn(async ({ data }: { data: Partial<ApiTxRow> }) => {
        if (apiTransactions.some((e) => e.sepayApiTxId === data.sepayApiTxId)) {
          const err = new Error('Unique constraint failed') as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        const now = new Date();
        const row: ApiTxRow = {
          id: seq++,
          createdAt: now,
          updatedAt: now,
          sepayApiTxId: data.sepayApiTxId!,
          bankBrandName: data.bankBrandName ?? '',
          accountNumber: data.accountNumber ?? '',
          subAccount: data.subAccount ?? null,
          transactionDate: data.transactionDate ?? '',
          transactionDateUtc: data.transactionDateUtc ?? null,
          transferType: data.transferType ?? '',
          amount: data.amount ?? 0,
          code: data.code ?? null,
          referenceNumber: data.referenceNumber ?? null,
          rawPayload: data.rawPayload ?? {},
          status: data.status ?? 'RECEIVED',
          verdict: data.verdict ?? false,
          unmatchedReason: data.unmatchedReason ?? null,
          orderId: data.orderId ?? null,
          paymentCode: data.paymentCode ?? null,
        };
        apiTransactions.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { sepayApiTxId: string } }) => {
        return apiTransactions.find((e) => e.sepayApiTxId === where.sepayApiTxId) ?? null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: number }; data: Partial<ApiTxRow> }) => {
          const target = apiTransactions.find((e) => e.id === where.id)!;
          Object.assign(target, data, { updatedAt: new Date() });
          return target;
        },
      ),
    },

    sepayReconcileState: {
      findUnique: jest.fn(async () => reconcileState),
      upsert: jest.fn(
        async ({
          create,
          update,
        }: {
          create: NonNullable<typeof reconcileState>;
          update: Partial<NonNullable<typeof reconcileState>>;
        }) => {
          if (!reconcileState) {
            reconcileState = { ...create, updatedAt: new Date() };
          } else {
            Object.assign(reconcileState, update, { updatedAt: new Date() });
          }
          return reconcileState;
        },
      ),
    },

    tenantSubscription: {
      findMany: jest.fn(
        async ({ where }: { where?: { tenantId?: number; status?: string } }) => {
          return subscriptions.filter(
            (s) =>
              (where?.tenantId === undefined || s.tenantId === where.tenantId) &&
              (where?.status === undefined || s.status === where.status),
          );
        },
      ),
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
            count += 1;
          }
          return { count };
        },
      ),
      create: jest.fn(async ({ data }: { data: Partial<SubscriptionRow> }) => {
        const row: SubscriptionRow = {
          id: seq++,
          createdAt: new Date(),
          tenantId: data.tenantId!,
          planId: data.planId!,
          status: data.status ?? 'ACTIVE',
          billingCycle: data.billingCycle ?? 'MONTHLY',
          startsAt: data.startsAt ?? new Date(),
          expiresAt: data.expiresAt ?? null,
          note: data.note ?? null,
        };
        subscriptions.push(row);
        return row;
      }),
    },
  };

  return prismaMock;
}

class MockAuthGuard {
  constructor(private readonly reflector: Reflector) {}

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
    const auth = req.headers['authorization'] ?? '';
    if (auth === 'Bearer root-token') {
      req.user = { id: 1, username: 'root', isRoot: true, permissions: [] };
      return true;
    }
    if (auth === 'Bearer user-token') {
      req.user = { id: 50, username: 'alice@example.com', isRoot: false, permissions: [] };
      return true;
    }
    throw new UnauthorizedException('Unauthorized');
  }
}

describe('SePay Payments Module (VietQR + Webhook + API v2 Reconciliation)', () => {
  let app: NestExpressApplication;
  let prismaMock: ReturnType<typeof createInMemoryPaymentsPrisma>;
  let httpServiceMock: { get: jest.Mock };
  let configValues: Record<string, unknown>;

  async function initApp(overrides: Record<string, unknown> = {}) {
    prismaMock = createInMemoryPaymentsPrisma();
    httpServiceMock = { get: jest.fn() };
    configValues = {
      NODE_ENV: 'test',
      SEPAY_ENV: 'sandbox',
      SEPAY_WEBHOOK_AUTH_MODE: 'hmac',
      SEPAY_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
      SEPAY_API_TOKEN: 'sepay-test-api-token',
      SEPAY_BANK_CODE: TEST_BANK_CODE,
      SEPAY_ACCOUNT_NUMBER: TEST_ACCOUNT_NUMBER,
      SEPAY_ACCOUNT_NAME: TEST_ACCOUNT_NAME,
      SEPAY_PAYMENT_CODE_PREFIX: 'TAI',
      SEPAY_DES_PREFIX: '',
      SEPAY_ORDER_TTL_MINUTES: 15,
      SEPAY_RECONCILE_INTERVAL_MINUTES: 20,
      ...overrides,
    };

    const entitlementMock = {
      getUserEntitlement: jest.fn(async () => ({
        tenant: {
          id: 10,
          code: 'alice-space',
          name: 'Alice Space',
          type: 'PERSONAL',
          status: 'ACTIVE',
          contactEmail: 'alice@example.com',
          notes: null,
          createdAt: new Date().toISOString(),
        },
        memberRole: 'OWNER',
        subscription: null,
        plan: null,
        quota: {
          period: '2026-11',
          usedSeconds: 0,
          usedMinutes: 0,
          limitMinutes: 60,
          remainingMinutes: 60,
          isUnlimited: false,
          canDub: true,
          blockReason: null,
        },
      })),
    };

    @Module({
      controllers: [
        SepayWebhookController,
        SaasPaymentsMeController,
        AdminSaasPaymentsController,
      ],
      providers: [
        SepayApiClient,
        SepayPaymentsService,
        AdminSaasGuard,
        { provide: PrismaService, useValue: prismaMock },
        { provide: HttpService, useValue: httpServiceMock },
        { provide: SaasEntitlementService, useValue: entitlementMock },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => configValues[k]) },
        },
      ],
    })
    class TestPaymentsModule {}

    const instance = await NestFactory.create<NestExpressApplication>(
      TestPaymentsModule,
      { bodyParser: false, logger: false },
    );
    instance.use(
      bodyParser.json({
        limit: '2mb',
        verify: (req, _res, buf) => {
          (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
    instance.setGlobalPrefix('api');
    instance.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    const reflector = instance.get(Reflector);
    instance.useGlobalGuards(
      new MockAuthGuard(reflector),
      new PermissionsGuard(reflector),
    );
    instance.useGlobalFilters(new HttpExceptionFilter());
    await instance.init();
    return instance;
  }

  async function createProOrder() {
    const res = await request(app.getHttpServer())
      .post('/api/v1/saas/me/payments/orders')
      .set('Authorization', 'Bearer user-token')
      .send({ planId: 2, billingCycle: 'MONTHLY' })
      .expect(201);
    return (res.body as {
      data: {
        id: number;
        paymentCode: string;
        amount: number;
        qrUrl: string | null;
        transferContent: string;
        expiresAt: string;
      };
    }).data;
  }

  function postSignedWebhook(
    payload: Record<string, unknown>,
    opts: { secret?: string; timestampSec?: number; signatureOverride?: string } = {},
  ) {
    const rawBody = JSON.stringify(payload);
    const ts = opts.timestampSec ?? Math.floor(Date.now() / 1000);
    const signed = signWebhookBody(
      rawBody,
      opts.secret ?? TEST_WEBHOOK_SECRET,
      ts,
    );
    return request(app.getHttpServer())
      .post('/api/v1/payments/sepay/webhook')
      .set('Content-Type', 'application/json')
      .set('X-SePay-Timestamp', signed.timestamp)
      .set('X-SePay-Signature', opts.signatureOverride ?? signed.signature)
      .send(rawBody);
  }

  beforeEach(async () => {
    app = await initApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Webhook Authentication (Fail Closed + HMAC + API Key)', () => {
    it('rejects bad HMAC signature with 401', async () => {
      const res = await postSignedWebhook(
        { id: 1001, transferType: 'in', transferAmount: 99000 },
        { signatureOverride: 'sha256=' + '0'.repeat(64) },
      ).expect(401);

      expect(res.body).toEqual({ statusCode: 401, message: 'Unauthorized' });
    });

    it('rejects expired HMAC timestamp (> 300s old) with 401', async () => {
      const oldTs = Math.floor(Date.now() / 1000) - 400;
      await postSignedWebhook(
        { id: 1002, transferType: 'in', transferAmount: 99000 },
        { timestampSec: oldTs },
      ).expect(401);
    });

    it('fails closed (rejects everything with 401) when SEPAY_WEBHOOK_SECRET is empty', async () => {
      configValues.SEPAY_WEBHOOK_SECRET = '';
      const rawBody = JSON.stringify({ id: 1003, transferType: 'in', transferAmount: 99000 });
      const ts = Math.floor(Date.now() / 1000);
      const signedWithEmpty = signWebhookBody(rawBody, '', ts);

      await request(app.getHttpServer())
        .post('/api/v1/payments/sepay/webhook')
        .set('Content-Type', 'application/json')
        .set('X-SePay-Timestamp', signedWithEmpty.timestamp)
        .set('X-SePay-Signature', signedWithEmpty.signature)
        .send(rawBody)
        .expect(401);

      // Fail-closed checkout: sepayEnabled must be false and creating a VietQR order rejected when secret is empty
      const cfg = await request(app.getHttpServer())
        .get('/api/v1/saas/me/payments/config')
        .set('Authorization', 'Bearer user-token')
        .expect(200);
      expect((cfg.body as { data: { sepayEnabled: boolean } }).data.sepayEnabled).toBe(false);

      await request(app.getHttpServer())
        .post('/api/v1/saas/me/payments/orders')
        .set('Authorization', 'Bearer user-token')
        .send({ planId: 2, billingCycle: 'MONTHLY' })
        .expect(503);
    });

    it('supports SEPAY_WEBHOOK_AUTH_MODE=apikey with Authorization: Apikey <secret>', async () => {
      configValues.SEPAY_WEBHOOK_AUTH_MODE = 'apikey';
      const order = await createProOrder();

      await request(app.getHttpServer())
        .post('/api/v1/payments/sepay/webhook')
        .set('Authorization', 'Apikey wrong-secret')
        .send({ id: 1004, code: order.paymentCode, transferType: 'in', transferAmount: 99000 })
        .expect(401);

      const ok = await request(app.getHttpServer())
        .post('/api/v1/payments/sepay/webhook')
        .set('Authorization', `Apikey ${TEST_WEBHOOK_SECRET}`)
        .send({
          id: 1004,
          gateway: TEST_BANK_CODE,
          transactionDate: formatVietnamTimestamp(new Date()),
          accountNumber: TEST_ACCOUNT_NUMBER,
          code: order.paymentCode,
          transferType: 'in',
          transferAmount: 99000,
          referenceCode: 'FT2611240001',
        })
        .expect(200);

      expect(ok.body).toEqual({ success: true });
    });
  });

  describe('Order Checkout, Exact Match, Idempotency & Concurrency', () => {
    it('creates VietQR order, fulfills on exact webhook, hides qrUrl when PAID, and replays verdict idempotently', async () => {
      const order = await createProOrder();
      expect(order.amount).toBe(99000);
      expect(order.qrUrl).toContain('https://vietqr.app/img?');
      expect(order.qrUrl).toContain(encodeURIComponent(order.transferContent));

      const txDate = formatVietnamTimestamp(new Date());
      const payload = {
        id: 2001,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        subAccount: null,
        code: order.paymentCode.toLowerCase(), // case-insensitive match
        content: `NGUYEN VAN A ${order.paymentCode}`,
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT2611240002',
        accumulated: 500000,
      };

      const first = await postSignedWebhook(payload).expect(200);
      expect(first.body).toEqual({ success: true });

      const state = prismaMock._state as {
        subscriptions: SubscriptionRow[];
        orders: OrderRow[];
      };
      expect(state.subscriptions).toHaveLength(1);
      expect(state.orders[0].status).toBe('PAID');

      // Polling status returns status & amount only (no personal data)
      const statusRes = await request(app.getHttpServer())
        .get(`/api/v1/saas/me/payments/orders/${order.paymentCode}/status`)
        .set('Authorization', 'Bearer user-token')
        .expect(200);
      expect(Object.keys((statusRes.body as { data: Record<string, unknown> }).data).sort()).toEqual([
        'amount',
        'expiresAt',
        'paidAmount',
        'paidAt',
        'paymentCode',
        'status',
      ]);

      // Listing orders now returns qrUrl: null because order is PAID
      const listRes = await request(app.getHttpServer())
        .get('/api/v1/saas/me/payments/orders')
        .set('Authorization', 'Bearer user-token')
        .expect(200);
      expect(
        (listRes.body as { data: Array<{ qrUrl: string | null }> }).data[0].qrUrl,
      ).toBeNull();

      // Same webhook id replayed -> returns 200 { success: true } and does NOT activate subscription twice!
      const replay = await postSignedWebhook(payload).expect(200);
      expect(replay.body).toEqual({ success: true });
      expect(state.subscriptions).toHaveLength(1);
    });

    it('two DIFFERENT transactions for the same order in parallel give ONE fulfillment (true + false)', async () => {
      const order = await createProOrder();
      const txDate = formatVietnamTimestamp(new Date());

      const txA = {
        id: 3001,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: order.paymentCode,
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT-PARALLEL-A',
      };
      const txB = {
        id: 3002,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: order.paymentCode,
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT-PARALLEL-B',
      };

      const [resA, resB] = await Promise.all([
        postSignedWebhook(txA).expect(200),
        postSignedWebhook(txB).expect(200),
      ]);

      const verdicts = [
        (resA.body as { success: boolean }).success,
        (resB.body as { success: boolean }).success,
      ].sort();
      expect(verdicts).toEqual([false, true]);

      const state = prismaMock._state as {
        subscriptions: SubscriptionRow[];
        webhookEvents: WebhookEventRow[];
      };
      expect(state.subscriptions).toHaveLength(1);
      expect(
        state.webhookEvents.some(
          (e) => e.status === 'UNMATCHED' && e.unmatchedReason === 'SECOND_PAYMENT',
        ),
      ).toBe(true);
    });
  });

  describe('Amount, Late Payment, Code & TransferType Policy Rules', () => {
    it('marks underpay and overpay as UNMATCHED and returns 200 { success: false } (and replay stays false)', async () => {
      const order = await createProOrder();
      const txDate = formatVietnamTimestamp(new Date());

      const underPayload = {
        id: 4001,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: order.paymentCode,
        transferType: 'in',
        transferAmount: 98000,
        referenceCode: 'FT-UNDER',
      };
      const overPayload = {
        id: 4002,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: order.paymentCode,
        transferType: 'in',
        transferAmount: 100000,
        referenceCode: 'FT-OVER',
      };

      const underRes = await postSignedWebhook(underPayload).expect(200);
      expect(underRes.body).toEqual({ success: false });

      // Replay of unmatched webhook id repeats false
      const underReplay = await postSignedWebhook(underPayload).expect(200);
      expect(underReplay.body).toEqual({ success: false });

      const overRes = await postSignedWebhook(overPayload).expect(200);
      expect(overRes.body).toEqual({ success: false });

      const state = prismaMock._state as {
        orders: OrderRow[];
        subscriptions: SubscriptionRow[];
        webhookEvents: WebhookEventRow[];
      };
      expect(state.orders[0].status).toBe('PENDING');
      expect(state.subscriptions).toHaveLength(0);
      expect(state.webhookEvents.map((e) => e.unmatchedReason)).toEqual([
        'UNDERPAID',
        'OVERPAID',
      ]);
    });

    it('rejects late payment after order EXPIRY (Asia/Ho_Chi_Minh +07:00) and after CANCEL as UNMATCHED', async () => {
      const expiredOrder = await createProOrder();
      const state = prismaMock._state as {
        orders: OrderRow[];
        subscriptions: SubscriptionRow[];
        webhookEvents: WebhookEventRow[];
      };
      // Force expiry 10 minutes ago
      state.orders[0].expiresAt = new Date(Date.now() - 10 * 60_000);

      const lateRes = await postSignedWebhook({
        id: 5001,
        gateway: TEST_BANK_CODE,
        transactionDate: formatVietnamTimestamp(new Date()),
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: expiredOrder.paymentCode,
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT-LATE',
      }).expect(200);
      expect(lateRes.body).toEqual({ success: false });
      expect(state.orders[0].status).toBe('EXPIRED');

      // Cancel second order then send transfer
      const canceledOrder = await createProOrder();
      await request(app.getHttpServer())
        .post(`/api/v1/saas/me/payments/orders/${canceledOrder.paymentCode}/cancel`)
        .set('Authorization', 'Bearer user-token')
        .expect(200);

      const canceledRes = await postSignedWebhook({
        id: 5002,
        gateway: TEST_BANK_CODE,
        transactionDate: formatVietnamTimestamp(new Date()),
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: canceledOrder.paymentCode,
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT-CANCELED',
      }).expect(200);
      expect(canceledRes.body).toEqual({ success: false });
      expect(state.subscriptions).toHaveLength(0);
      expect(state.webhookEvents.map((e) => e.unmatchedReason)).toEqual([
        'ORDER_EXPIRED',
        'ORDER_CANCELED',
      ]);
    });

    it('handles unknown/empty code (without regex-parsing content) and transferType=out as UNMATCHED', async () => {
      const order = await createProOrder();
      const txDate = formatVietnamTimestamp(new Date());

      // Empty code even though content mentions the code -> NEVER regex-parse content!
      const emptyCodeRes = await postSignedWebhook({
        id: 6001,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: null,
        content: `Chuyen khoan ${order.paymentCode}`,
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT-NOCODE',
      }).expect(200);
      expect(emptyCodeRes.body).toEqual({ success: false });

      // Unknown code
      const unknownCodeRes = await postSignedWebhook({
        id: 6002,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: 'TAI99999999',
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT-UNKNOWN',
      }).expect(200);
      expect(unknownCodeRes.body).toEqual({ success: false });

      // Outgoing transfer
      const outRes = await postSignedWebhook({
        id: 6003,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: order.paymentCode,
        transferType: 'out',
        transferAmount: 99000,
        referenceCode: 'FT-OUT',
      }).expect(200);
      expect(outRes.body).toEqual({ success: false });

      const state = prismaMock._state as {
        subscriptions: SubscriptionRow[];
        webhookEvents: WebhookEventRow[];
      };
      expect(state.subscriptions).toHaveLength(0);
      expect(state.webhookEvents.map((e) => e.unmatchedReason)).toEqual([
        'EMPTY_CODE',
        'ORDER_NOT_FOUND',
        'NON_INCOMING_TRANSFER',
      ]);
    });

    it('returns 500 without stack trace if DB fails before storing webhook event', async () => {
      (prismaMock.sepayWebhookEvent as { create: jest.Mock }).create.mockRejectedValueOnce(
        new Error('Connection terminated unexpectedly'),
      );

      const res = await postSignedWebhook({
        id: 7001,
        gateway: TEST_BANK_CODE,
        transactionDate: formatVietnamTimestamp(new Date()),
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: 'TAI12345678',
        transferType: 'in',
        transferAmount: 99000,
      }).expect(500);

      expect(res.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
    });
  });

  describe('SePay API v2 Reconciliation + Late Webhook Cross-Source Dedup + Admin Privacy', () => {
    it('reconciles missed order via API v2 and late webhook for SAME transfer replies 200 { success: true } without double fulfillment', async () => {
      const order = await createProOrder();
      const txDate = formatVietnamTimestamp(new Date());

      httpServiceMock.get.mockReturnValueOnce(
        of({
          status: 200,
          headers: {},
          data: {
            status: 'success',
            data: [
              {
                id: 'uuid-api-tx-0001',
                transaction_date: txDate,
                account_number: TEST_ACCOUNT_NUMBER,
                transfer_type: 'in',
                amount_in: 99000,
                amount_out: 0,
                transaction_content: `SECRET BUYER NAME ${order.paymentCode}`,
                reference_number: 'FT-RECON-001',
                code: order.paymentCode,
                bank_brand_name: TEST_BANK_CODE,
              },
            ],
            meta: { pagination: { current_page: 1, last_page: 1, has_more: false } },
          },
        }),
      );

      const reconRes = await request(app.getHttpServer())
        .post('/api/v1/admin/saas/payments/reconcile')
        .set('Authorization', 'Bearer root-token')
        .expect(200);

      expect(
        (reconRes.body as { data: { fetched: number; matched: number; cursorId: string } }).data,
      ).toMatchObject({
        fetched: 1,
        matched: 1,
        cursorId: 'uuid-api-tx-0001',
      });

      const state = prismaMock._state as {
        orders: OrderRow[];
        subscriptions: SubscriptionRow[];
      };
      expect(state.orders[0].status).toBe('PAID');
      expect(state.orders[0].paidSource).toBe('RECONCILIATION');
      expect(state.subscriptions).toHaveLength(1);

      // Late webhook arrives for the EXACT SAME transfer
      const lateWebhookRes = await postSignedWebhook({
        id: 8001,
        gateway: TEST_BANK_CODE,
        transactionDate: txDate,
        accountNumber: TEST_ACCOUNT_NUMBER,
        code: order.paymentCode,
        content: `SECRET BUYER NAME ${order.paymentCode}`,
        transferType: 'in',
        transferAmount: 99000,
        referenceCode: 'FT-RECON-001',
      }).expect(200);

      expect(lateWebhookRes.body).toEqual({ success: true });
      // Subscription STILL activated only ONCE!
      expect(state.subscriptions).toHaveLength(1);

      // Admin events endpoint masks account number and NEVER exposes content/description/rawPayload
      const eventsRes = await request(app.getHttpServer())
        .get('/api/v1/admin/saas/payments/events')
        .set('Authorization', 'Bearer root-token')
        .expect(200);
      const firstEvent = (
        eventsRes.body as { data: Array<Record<string, unknown>> }
      ).data[0];
      expect(firstEvent.maskedAccountNumber).toBe(
        maskAccountNumber(TEST_ACCOUNT_NUMBER),
      );
      expect(firstEvent).not.toHaveProperty('accountNumber');
      expect(firstEvent).not.toHaveProperty('content');
      expect(firstEvent).not.toHaveProperty('description');
      expect(firstEvent).not.toHaveProperty('rawPayload');

      // Admin webhook-ID numeric search includes BigInt sepayWebhookId in where.OR
      await request(app.getHttpServer())
        .get('/api/v1/admin/saas/payments/events?search=8001')
        .set('Authorization', 'Bearer root-token')
        .expect(200);
      expect(
        (prismaMock.sepayWebhookEvent as { findMany: jest.Mock }).findMany,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([{ sepayWebhookId: 8001n }]),
          }),
        }),
      );

      // Admin orders filter applies expiresAt constraints for PENDING and EXPIRED, and cancel rejects expired orders
      const expOrder = await createProOrder();
      const orderRows = (prismaMock._state as { orders: OrderRow[] }).orders;
      orderRows.find((o) => o.id === expOrder.id)!.expiresAt = new Date(
        Date.now() - 60_000,
      );

      await request(app.getHttpServer())
        .get('/api/v1/admin/saas/payments/orders?status=PENDING')
        .set('Authorization', 'Bearer root-token')
        .expect(200);
      expect(
        (prismaMock.paymentOrder as { findMany: jest.Mock }).findMany,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              expect.objectContaining({
                status: 'PENDING',
                expiresAt: { gt: expect.any(Date) },
              }),
            ],
          },
        }),
      );

      await request(app.getHttpServer())
        .get('/api/v1/admin/saas/payments/orders?status=EXPIRED')
        .set('Authorization', 'Bearer root-token')
        .expect(200);
      expect(
        (prismaMock.paymentOrder as { findMany: jest.Mock }).findMany,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              {
                OR: [
                  { status: 'EXPIRED' },
                  expect.objectContaining({
                    status: 'PENDING',
                    expiresAt: { lte: expect.any(Date) },
                  }),
                ],
              },
            ],
          },
        }),
      );

      await request(app.getHttpServer())
        .post(`/api/v1/admin/saas/payments/orders/${expOrder.id}/cancel`)
        .set('Authorization', 'Bearer root-token')
        .expect(409);
      expect(orderRows.find((o) => o.id === expOrder.id)!.status).toBe(
        'EXPIRED',
      );
    });
  });
});
