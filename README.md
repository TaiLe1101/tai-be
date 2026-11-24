# TAI Backend (`tai-be`)

NestJS 11 + Prisma 7 (PostgreSQL) + Redis backend for TAI Desktop auto-updates, realtime dubbing gateway, multi-tenant SaaS subscriptions, and automated SePay bank-transfer payments.

## Quick Start

```bash
npm install
npx prisma migrate deploy --config prisma7.config.ts
npx prisma generate --config prisma7.config.ts
npm run db:seed
npm run start:dev
```

Build & test:

```bash
npm run build
npm test
```

---

## Automated SePay Payments (VietQR + Webhook + API v2 Reconciliation)

### Payment Policies Implemented
- **Integration method**: Dynamic VietQR (`https://vietqr.app/img`) + realtime SePay Webhook (`POST /api/v1/payments/sepay/webhook`) + scheduled/on-demand SePay API v2 reconciliation (`GET /v2/transactions`).
- **Exact amount match only** (integer VND): only a single incoming transfer with `transferAmount === order.amount` pays the order. Underpayments or overpayments are stored as `UNMATCHED` (`verdict: false`, HTTP `200 {"success": false}`) for Admin review/refund.
- **Late payments after expiry/cancel**: stored as `UNMATCHED` (`verdict: false`, HTTP `200 {"success": false}`); never auto-activates subscriptions.
- **Fail closed & privacy (Decree 13/2023/NĐ-CP)**: empty `SEPAY_WEBHOOK_SECRET` rejects every webhook with `401`. HMAC-SHA256 verifies `${X-SePay-Timestamp}.${rawBody}` with a 5-minute replay window and constant-time comparison. Application logs record only identifiers and masked account numbers (`****1234`), never transfer memos, sender names, signatures, or tokens.

### Environment Variables (`.env`)

Copy variable names from `.env.example` and populate values in your server `.env` (never commit `.env`):

| Variable | Default | Description |
|---|---|---|
| `SEPAY_ENV` | `sandbox` | `sandbox` (`https://userapi-sandbox.sepay.vn/v2`) or `production` (`https://userapi.sepay.vn/v2`) |
| `SEPAY_WEBHOOK_AUTH_MODE` | `hmac` | `hmac` (recommended: `X-SePay-Timestamp` + `X-SePay-Signature`) or `apikey` (`Authorization: Apikey <secret>`) |
| `SEPAY_WEBHOOK_SECRET` | `""` | Shared webhook secret from SePay (**required**; empty rejects all webhooks with `401`) |
| `SEPAY_API_TOKEN` | `""` | Company Bearer API key for SePay API v2 reconciliation |
| `SEPAY_BANK_CODE` | `""` | Receiving bank code/short_name (e.g. `MBBank`, `ACB`, `Vietcombank`) |
| `SEPAY_ACCOUNT_NUMBER` | `""` | Receiving bank account or VA number |
| `SEPAY_ACCOUNT_NAME` | `""` | Account holder display name for checkout UI |
| `SEPAY_PAYMENT_CODE_PREFIX` | `TAI` | Uppercase prefix matching SePay payment-code structure (`TAI` + 8 digits) |
| `SEPAY_DES_PREFIX` | `""` | Optional bank-required memo prefix placed before payment code (e.g. `SEVQR` for personal VietinBank) |
| `SEPAY_ORDER_TTL_MINUTES` | `15` | Order & VietQR expiration window in minutes |
| `SEPAY_RECONCILE_INTERVAL_MINUTES` | `20` | Background SePay API v2 reconciliation interval in minutes |

### Testing in Sandbox with `sepay` CLI

1. Sign in to the SePay CLI:
   ```bash
   SEPAY_LANG=vi sepay login
   ```
2. Initialize Sandbox / Test mode (creates test bank account & payment-code structure matching `TAI` + 8 digits):
   ```bash
   sepay sandbox init
   ```
   Configure `SEPAY_ENV="sandbox"`, `SEPAY_WEBHOOK_AUTH_MODE="hmac"`, `SEPAY_WEBHOOK_SECRET`, `SEPAY_API_TOKEN`, `SEPAY_BANK_CODE`, `SEPAY_ACCOUNT_NUMBER`, and `SEPAY_ACCOUNT_NAME` in `.env`, then start `tai-be` (`npm run start:dev`).
3. Forward Sandbox webhooks to your local server without a third-party tunnel:
   ```bash
   sepay webhook listen --forward-to http://127.0.0.1:3105/api/v1/payments/sepay/webhook
   ```
4. Create a payment order from TAI Desktop (or `POST /api/v1/saas/me/payments/orders`) to obtain `paymentCode` (e.g. `TAI12345678`) and exact `amount`.
5. Simulate a bank transfer in Sandbox:
   ```bash
   sepay sandbox simulate --amount 99000 --content "TAI12345678"
   ```
   Verify the order transitions to `PAID`, the tenant subscription activates automatically, and re-sending the same webhook returns `200 {"success": true}` idempotently.

### Go-Live Checklist (Production)

1. Link your real receiving bank account in **my.sepay.vn** and confirm whether the bank requires a VA or `SEVQR` memo prefix (`https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code`).
2. Configure **Công ty → Cấu hình chung → Cấu trúc mã thanh toán** with prefix `TAI` (uppercase) and **Số nguyên** length `8`–`8` (fixed 8 digits).
3. Create the production webhook in **my.sepay.vn** pointing to `https://<your-api-domain>/api/v1/payments/sepay/webhook`:
   - Direction: **Tiền vào** on the receiving account(s) only.
   - Enable **Dùng để xác thực thanh toán** (`--verify-payment`).
   - Leave **Chỉ gửi khi có mã thanh toán** and **Lọc theo mã thanh toán** off so unmatched transfers are still visible for review/refund.
   - Auth: **HMAC-SHA256** (copy secret into production `SEPAY_WEBHOOK_SECRET`).
4. Create a production API Key in **my.sepay.vn → Cài đặt công ty → API Keys** and set `SEPAY_ENV="production"` and `SEPAY_API_TOKEN`.
5. Run one small real end-to-end transfer test and verify `Xác thực tự động = Thành công` in **Lịch sử gửi**.
6. Turn on **Tự động gửi lại khi server trả lỗi** and webhook failure alerts in **my.sepay.vn**, and monitor **Quản lý SaaS → Thanh toán SePay** in `tai-admin` for any `UNMATCHED` transfers.
