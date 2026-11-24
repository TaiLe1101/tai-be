-- CreateEnum
CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PaymentPaidSource" AS ENUM ('WEBHOOK', 'RECONCILIATION');

-- CreateEnum
CREATE TYPE "SepayEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'UNMATCHED', 'FAILED');

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "payment_code" TEXT NOT NULL,
    "tenant_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "plan_id" INTEGER NOT NULL,
    "billing_cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "bank_code" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "transfer_content" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "paid_amount" INTEGER,
    "paid_source" "PaymentPaidSource",
    "paid_reference_code" TEXT,
    "paid_transaction_date" TEXT,
    "paid_account_number" TEXT,
    "paid_webhook_id" BIGINT,
    "paid_api_tx_id" TEXT,
    "activated_subscription_id" INTEGER,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sepay_webhook_events" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sepay_webhook_id" BIGINT NOT NULL,
    "gateway" TEXT NOT NULL,
    "transaction_date" TEXT NOT NULL,
    "transaction_date_utc" TIMESTAMP(3),
    "account_number" TEXT NOT NULL,
    "sub_account" TEXT,
    "code" TEXT,
    "transfer_type" TEXT NOT NULL,
    "transfer_amount" INTEGER NOT NULL,
    "accumulated" INTEGER NOT NULL DEFAULT 0,
    "reference_code" TEXT,
    "raw_payload" JSONB NOT NULL,
    "status" "SepayEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "verdict" BOOLEAN NOT NULL DEFAULT false,
    "unmatched_reason" TEXT,
    "order_id" INTEGER,
    "payment_code" TEXT,

    CONSTRAINT "sepay_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sepay_api_transactions" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sepay_api_tx_id" TEXT NOT NULL,
    "bank_brand_name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "sub_account" TEXT,
    "transaction_date" TEXT NOT NULL,
    "transaction_date_utc" TIMESTAMP(3),
    "transfer_type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "code" TEXT,
    "reference_number" TEXT,
    "raw_payload" JSONB NOT NULL,
    "status" "SepayEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "verdict" BOOLEAN NOT NULL DEFAULT false,
    "unmatched_reason" TEXT,
    "order_id" INTEGER,
    "payment_code" TEXT,

    CONSTRAINT "sepay_api_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sepay_reconcile_states" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_cursor_id" TEXT,
    "last_fetched_count" INTEGER NOT NULL DEFAULT 0,
    "last_matched_count" INTEGER NOT NULL DEFAULT 0,
    "last_unmatched_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sepay_reconcile_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_payment_code_key" ON "payment_orders"("payment_code");

-- CreateIndex
CREATE INDEX "payment_orders_tenant_id_created_at_idx" ON "payment_orders"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_orders_status_expires_at_idx" ON "payment_orders"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sepay_webhook_events_sepay_webhook_id_key" ON "sepay_webhook_events"("sepay_webhook_id");

-- CreateIndex
CREATE INDEX "sepay_webhook_events_status_created_at_idx" ON "sepay_webhook_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "sepay_webhook_events_code_idx" ON "sepay_webhook_events"("code");

-- CreateIndex
CREATE INDEX "sepay_webhook_events_order_id_idx" ON "sepay_webhook_events"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "sepay_api_transactions_sepay_api_tx_id_key" ON "sepay_api_transactions"("sepay_api_tx_id");

-- CreateIndex
CREATE INDEX "sepay_api_transactions_status_created_at_idx" ON "sepay_api_transactions"("status", "created_at");

-- CreateIndex
CREATE INDEX "sepay_api_transactions_code_idx" ON "sepay_api_transactions"("code");

-- CreateIndex
CREATE INDEX "sepay_api_transactions_order_id_idx" ON "sepay_api_transactions"("order_id");

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sepay_webhook_events" ADD CONSTRAINT "sepay_webhook_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sepay_api_transactions" ADD CONSTRAINT "sepay_api_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
