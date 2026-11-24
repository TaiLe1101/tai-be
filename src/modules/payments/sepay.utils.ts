import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type {
  PaymentOrderDto,
  PaymentOrderStatusDto,
  PaymentOrderStatusValue,
  PaymentPaidSourceValue,
  SepayEventStatusValue,
  SepayWebhookEventAdminDto,
} from './sepay-payments.types';

const HMAC_REPLAY_WINDOW_SECONDS = 300;
const VIETQR_BASE_URL = 'https://vietqr.app/img';
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

export function constantTimeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifySepayWebhookAuth(params: {
  mode: 'hmac' | 'apikey';
  secret: string;
  timestampHeader?: string;
  signatureHeader?: string;
  authorizationHeader?: string;
  rawBody?: Buffer;
  nowMs?: number;
}): boolean {
  const secret = (params.secret ?? '').trim();
  // Fail closed: empty/missing secret rejects every callback.
  if (!secret) {
    return false;
  }

  if (params.mode === 'apikey') {
    const auth = (params.authorizationHeader ?? '').trim();
    const match = /^Apikey\s+(.+)$/i.exec(auth);
    if (!match) {
      return false;
    }
    return constantTimeEqualString(match[1].trim(), secret);
  }

  // Default: HMAC-SHA256 over `${timestamp}.${rawBody}`
  const tsRaw = (params.timestampHeader ?? '').trim();
  const sigRaw = (params.signatureHeader ?? '').trim();
  if (!tsRaw || !sigRaw || !params.rawBody || !Buffer.isBuffer(params.rawBody)) {
    return false;
  }

  if (!/^\d+$/.test(tsRaw)) {
    return false;
  }
  const timestamp = Number.parseInt(tsRaw, 10);
  if (!Number.isSafeInteger(timestamp)) {
    return false;
  }

  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > HMAC_REPLAY_WINDOW_SECONDS) {
    return false;
  }

  const sigMatch = /^sha256=([0-9a-f]{64})$/i.exec(sigRaw);
  if (!sigMatch) {
    return false;
  }

  const signedBytes = Buffer.concat([
    Buffer.from(`${tsRaw}.`, 'utf8'),
    params.rawBody,
  ]);
  const expectedHex = createHmac('sha256', secret)
    .update(signedBytes)
    .digest('hex');

  return constantTimeEqualString(sigMatch[1].toLowerCase(), expectedHex);
}

export function maskAccountNumber(accountNumber: string | null | undefined): string {
  const cleaned = String(accountNumber ?? '').trim();
  if (!cleaned) return '****';
  if (cleaned.length <= 4) return `****${cleaned}`;
  return `****${cleaned.slice(-4)}`;
}

export function normalizeOptionalField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return value === 0 ? null : String(value);
  }
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === '0') {
    return null;
  }
  return trimmed;
}

export function parseVietnamTransactionDate(
  raw: string | null | undefined,
): Date | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  // SePay format: YYYY-MM-DD HH:mm:ss (Asia/Ho_Chi_Minh UTC+7, no zone)
  const localMatch =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(trimmed);
  if (localMatch) {
    const parsed = new Date(`${localMatch[1]}T${localMatch[2]}+07:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatVietnamTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + VIETNAM_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

export function normalizePaymentCodePrefix(prefix: string | undefined): string {
  const cleaned = (prefix ?? 'TAI')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return cleaned || 'TAI';
}

export function generatePaymentCode(prefix: string): string {
  const normalizedPrefix = normalizePaymentCodePrefix(prefix);
  const digits = String(randomInt(0, 100_000_000)).padStart(8, '0');
  return `${normalizedPrefix}${digits}`;
}

export function buildTransferContent(
  desPrefix: string | undefined,
  paymentCode: string,
): string {
  const safePrefix = (desPrefix ?? '')
    .trim()
    .replace(/[^A-Za-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [safePrefix, paymentCode].filter(Boolean).join(' ');
}

export function buildVietQrUrl(params: {
  bankCode: string;
  accountNumber: string;
  amount: number;
  transferContent: string;
}): string {
  const query = new URLSearchParams({
    acc: params.accountNumber.trim(),
    bank: params.bankCode.trim(),
    amount: String(Math.trunc(params.amount)),
    des: params.transferContent.trim(),
    template: 'compact',
  });
  return `${VIETQR_BASE_URL}?${query.toString()}`;
}

export function isSameBankTransfer(
  order: {
    paymentCode: string;
    paidAmount: number | null;
    paidTransactionDate: string | null;
    paidAccountNumber: string | null;
    paidReferenceCode: string | null;
  },
  transfer: {
    code: string | null;
    amount: number;
    transactionDate: string;
    accountNumber: string;
    referenceCode: string | null;
  },
): boolean {
  if (!transfer.code) return false;
  if (transfer.code.toLowerCase() !== order.paymentCode.toLowerCase()) {
    return false;
  }
  if (order.paidAmount === null || order.paidAmount !== transfer.amount) {
    return false;
  }

  const orderAcc = String(order.paidAccountNumber ?? '').trim();
  const txAcc = String(transfer.accountNumber ?? '').trim();
  if (orderAcc && txAcc && orderAcc !== txAcc) {
    return false;
  }

  const orderDate = parseVietnamTransactionDate(order.paidTransactionDate);
  const txDate = parseVietnamTransactionDate(transfer.transactionDate);
  if (orderDate && txDate) {
    if (Math.abs(orderDate.getTime() - txDate.getTime()) > 1000) {
      return false;
    }
  } else if (
    order.paidTransactionDate &&
    transfer.transactionDate &&
    order.paidTransactionDate.trim() !== transfer.transactionDate.trim()
  ) {
    return false;
  }

  const orderRef = normalizeOptionalField(order.paidReferenceCode);
  const txRef = normalizeOptionalField(transfer.referenceCode);
  if (orderRef && txRef && orderRef !== txRef) {
    return false;
  }

  return true;
}

export function isPrismaUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002';
}

export function toPaymentOrderDto(
  order: {
    id: number;
    paymentCode: string;
    tenantId: number;
    userId: number;
    planId: number;
    billingCycle: 'MONTHLY' | 'YEARLY' | 'LIFETIME';
    amount: number;
    currency: string;
    status: PaymentOrderStatusValue;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    transferContent: string;
    expiresAt: Date | string;
    paidAt: Date | string | null;
    paidAmount: number | null;
    paidSource: PaymentPaidSourceValue | null;
    paidReferenceCode: string | null;
    createdAt: Date | string;
    plan?: { id: number; code: string; name: string } | null;
    tenant?: { id: number; code: string; name: string } | null;
  },
  now = new Date(),
): PaymentOrderDto {
  const expiresDate =
    order.expiresAt instanceof Date ? order.expiresAt : new Date(order.expiresAt);
  const isEffectivePending =
    order.status === 'PENDING' && expiresDate.getTime() > now.getTime();
  const effectiveStatus: PaymentOrderStatusValue =
    order.status === 'PENDING' && expiresDate.getTime() <= now.getTime()
      ? 'EXPIRED'
      : order.status;

  return {
    id: order.id,
    paymentCode: order.paymentCode,
    tenantId: order.tenantId,
    userId: order.userId,
    planId: order.planId,
    billingCycle: order.billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY',
    amount: order.amount,
    currency: order.currency,
    status: effectiveStatus,
    bankCode: order.bankCode,
    accountNumber: order.accountNumber,
    accountName: order.accountName,
    transferContent: order.transferContent,
    qrUrl: isEffectivePending
      ? buildVietQrUrl({
          bankCode: order.bankCode,
          accountNumber: order.accountNumber,
          amount: order.amount,
          transferContent: order.transferContent,
        })
      : null,
    expiresAt: expiresDate.toISOString(),
    paidAt:
      order.paidAt === null
        ? null
        : order.paidAt instanceof Date
          ? order.paidAt.toISOString()
          : String(order.paidAt),
    paidAmount: order.paidAmount,
    paidSource: order.paidSource,
    paidReferenceCode: order.paidReferenceCode,
    createdAt:
      order.createdAt instanceof Date
        ? order.createdAt.toISOString()
        : String(order.createdAt),
    ...(order.plan
      ? {
          plan: {
            id: order.plan.id,
            code: order.plan.code,
            name: order.plan.name,
          },
        }
      : {}),
    ...(order.tenant
      ? {
          tenant: {
            id: order.tenant.id,
            code: order.tenant.code,
            name: order.tenant.name,
          },
        }
      : {}),
  };
}

export function toPaymentOrderStatusDto(
  order: {
    paymentCode: string;
    status: PaymentOrderStatusValue;
    amount: number;
    paidAmount: number | null;
    expiresAt: Date | string;
    paidAt: Date | string | null;
  },
  now = new Date(),
): PaymentOrderStatusDto {
  const expiresDate =
    order.expiresAt instanceof Date ? order.expiresAt : new Date(order.expiresAt);
  const effectiveStatus: PaymentOrderStatusValue =
    order.status === 'PENDING' && expiresDate.getTime() <= now.getTime()
      ? 'EXPIRED'
      : order.status;

  return {
    paymentCode: order.paymentCode,
    status: effectiveStatus,
    amount: order.amount,
    paidAmount: order.paidAmount,
    expiresAt: expiresDate.toISOString(),
    paidAt:
      order.paidAt === null
        ? null
        : order.paidAt instanceof Date
          ? order.paidAt.toISOString()
          : String(order.paidAt),
  };
}

export function toSepayWebhookEventAdminDto(event: {
  id: number;
  sepayWebhookId: bigint | number | string;
  gateway: string;
  transactionDate: string;
  accountNumber: string;
  subAccount: string | null;
  code: string | null;
  transferType: string;
  transferAmount: number;
  referenceCode: string | null;
  status: SepayEventStatusValue;
  verdict: boolean;
  unmatchedReason: string | null;
  orderId: number | null;
  paymentCode: string | null;
  createdAt: Date | string;
}): SepayWebhookEventAdminDto {
  return {
    id: event.id,
    sepayWebhookId: String(event.sepayWebhookId),
    gateway: event.gateway,
    transactionDate: event.transactionDate,
    maskedAccountNumber: maskAccountNumber(event.accountNumber),
    subAccount: event.subAccount,
    code: event.code,
    transferType: event.transferType,
    transferAmount: event.transferAmount,
    referenceCode: event.referenceCode,
    status: event.status,
    verdict: event.verdict,
    unmatchedReason: event.unmatchedReason,
    orderId: event.orderId,
    paymentCode: event.paymentCode,
    createdAt:
      event.createdAt instanceof Date
        ? event.createdAt.toISOString()
        : String(event.createdAt),
  };
}
