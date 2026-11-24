export type PaymentOrderStatusValue =
  | 'PENDING'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELED';

export type PaymentPaidSourceValue = 'WEBHOOK' | 'RECONCILIATION';

export type SepayEventStatusValue =
  | 'RECEIVED'
  | 'PROCESSED'
  | 'UNMATCHED'
  | 'FAILED';

export interface PaymentConfigDto {
  sepayEnabled: boolean;
  bankCode: string | null;
  accountName: string | null;
  orderTtlMinutes: number;
}

export interface PaymentOrderDto {
  id: number;
  paymentCode: string;
  tenantId: number;
  userId: number;
  planId: number;
  billingCycle: 'MONTHLY' | 'YEARLY';
  amount: number;
  currency: string;
  status: PaymentOrderStatusValue;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  transferContent: string;
  qrUrl: string | null;
  expiresAt: string;
  paidAt: string | null;
  paidAmount: number | null;
  paidSource: PaymentPaidSourceValue | null;
  paidReferenceCode: string | null;
  createdAt: string;
  plan?: { id: number; code: string; name: string };
  tenant?: { id: number; code: string; name: string };
}

export interface PaymentOrderStatusDto {
  paymentCode: string;
  status: PaymentOrderStatusValue;
  amount: number;
  paidAmount: number | null;
  expiresAt: string;
  paidAt: string | null;
}

export interface SepayWebhookEventAdminDto {
  id: number;
  sepayWebhookId: string;
  gateway: string;
  transactionDate: string;
  maskedAccountNumber: string;
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
  createdAt: string;
}

export interface SepayReconcileSummaryDto {
  enabled: boolean;
  env: 'sandbox' | 'production';
  lastRunAt: string | null;
  lastCursorId: string | null;
  lastFetchedCount: number;
  lastMatchedCount: number;
  lastUnmatchedCount: number;
  pendingOrders: number;
  paidOrders: number;
  unmatchedEvents: number;
}

export interface SepayReconcileRunResultDto {
  fetched: number;
  matched: number;
  unmatched: number;
  alreadyHandled: number;
  cursorId: string | null;
}

export interface SepayOrderReconcileResultDto {
  matched: boolean;
  order: PaymentOrderDto;
  checkedTransactions: number;
}

export interface SepayWebhookPayload {
  id: number | string;
  gateway?: string | null;
  transactionDate?: string | null;
  accountNumber?: string | null;
  subAccount?: string | number | null;
  code?: string | number | null;
  content?: string | null;
  transferType?: string | null;
  description?: string | null;
  transferAmount?: number | string | null;
  referenceCode?: string | number | null;
  accumulated?: number | string | null;
}

export interface SepayApiTransactionItem {
  id: string;
  transaction_date: string;
  account_number: string;
  va?: string | null;
  sub_account?: string | null;
  transfer_type?: string | null;
  amount_in?: number | string | null;
  amount_out?: number | string | null;
  accumulated?: number | string | null;
  transaction_content?: string | null;
  reference_number?: string | null;
  code?: string | null;
  bank_brand_name?: string | null;
  bank_account_id?: string | null;
  va_id?: string | null;
  webhook_success?: number | null;
}
