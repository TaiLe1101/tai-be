import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type { SepayApiTransactionItem } from './sepay-payments.types';

const SANDBOX_BASE_URL = 'https://userapi-sandbox.sepay.vn/v2';
const PRODUCTION_BASE_URL = 'https://userapi.sepay.vn/v2';
const DEFAULT_PAGE_DELAY_MS = 400;
const MAX_PAGES_PER_RUN = 50;
const MAX_429_RETRIES = 3;

interface SepayV2ListResponse {
  status?: string;
  data?: SepayApiTransactionItem[];
  meta?: {
    pagination?: {
      total?: number;
      per_page?: number;
      current_page?: number;
      last_page?: number;
      has_more?: boolean;
    };
  };
}

@Injectable()
export class SepayApiClient {
  private readonly logger = new Logger(SepayApiClient.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  get env(): 'sandbox' | 'production' {
    return this.configService.get<string>('SEPAY_ENV') === 'production'
      ? 'production'
      : 'sandbox';
  }

  get baseUrl(): string {
    return this.env === 'production' ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
  }

  get isConfigured(): boolean {
    return Boolean((this.configService.get<string>('SEPAY_API_TOKEN') || '').trim());
  }

  private get apiToken(): string {
    return (this.configService.get<string>('SEPAY_API_TOKEN') || '').trim();
  }

  private get pageDelayMs(): number {
    return this.configService.get<string>('NODE_ENV') === 'test'
      ? 0
      : DEFAULT_PAGE_DELAY_MS;
  }

  async listTransactionsSince(params: {
    sinceId?: string | null;
    transactionDateFrom?: string;
    perPage?: number;
  }): Promise<SepayApiTransactionItem[]> {
    const perPage = Math.min(100, Math.max(1, params.perPage ?? 100));
    const all: SepayApiTransactionItem[] = [];

    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      if (page > 1 && this.pageDelayMs > 0) {
        await this.sleep(this.pageDelayMs);
      }

      const query: Record<string, string | number> = {
        transaction_date_sort: 'asc',
        per_page: perPage,
        page,
      };
      if (params.sinceId) {
        query.since_id = params.sinceId;
      } else if (params.transactionDateFrom) {
        query.transaction_date_from = params.transactionDateFrom;
      }

      const response = await this.getTransactionsPage(query);
      const rows = Array.isArray(response.data) ? response.data : [];
      if (rows.length === 0) {
        break;
      }

      all.push(...rows);

      const pagination = response.meta?.pagination;
      const hasMore =
        pagination?.has_more === true ||
        (pagination?.current_page !== undefined &&
          pagination?.last_page !== undefined &&
          pagination.current_page < pagination.last_page);
      if (!hasMore) {
        break;
      }
    }

    return all;
  }

  async searchTransactionsByQuery(params: {
    q: string;
    transactionDateFrom?: string;
  }): Promise<SepayApiTransactionItem[]> {
    const query: Record<string, string | number> = {
      q: params.q,
      per_page: 100,
    };
    if (params.transactionDateFrom) {
      query.transaction_date_from = params.transactionDateFrom;
    }

    const response = await this.getTransactionsPage(query);
    return Array.isArray(response.data) ? response.data : [];
  }

  private async getTransactionsPage(
    params: Record<string, string | number>,
  ): Promise<SepayV2ListResponse> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình SEPAY_API_TOKEN để đối soát với SePay API v2',
      );
    }

    const url = `${this.baseUrl}/transactions`;
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      try {
        const res = await firstValueFrom(
          this.httpService.get<SepayV2ListResponse>(url, {
            params,
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              Accept: 'application/json',
            },
            timeout: 15_000,
            validateStatus: () => true,
          }),
        );

        if (res.status === 429 && attempt < MAX_429_RETRIES) {
          const waitMs = this.resolveRetryDelayMs(
            (res.headers ?? {}) as Record<string, unknown>,
            attempt,
          );
          this.logger.warn(
            `SePay API v2 rate limited (429); backing off ${waitMs}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`,
          );
          await this.sleep(waitMs);
          continue;
        }

        if (res.status < 200 || res.status >= 300) {
          this.logger.error(
            `SePay API v2 /transactions returned HTTP ${res.status} (env=${this.env})`,
          );
          throw new BadGatewayException(
            `SePay API v2 trả về mã lỗi HTTP ${res.status}`,
          );
        }

        return res.data ?? { data: [] };
      } catch (error) {
        if (
          error instanceof BadGatewayException ||
          error instanceof ServiceUnavailableException
        ) {
          throw error;
        }
        this.logger.error(
          `SePay API v2 /transactions request failed (env=${this.env})`,
        );
        throw new BadGatewayException(
          'Không thể kết nối tới SePay API v2 để đối soát giao dịch',
        );
      }
    }

    throw new BadGatewayException(
      'SePay API v2 vượt quá giới hạn tần suất (429)',
    );
  }

  private resolveRetryDelayMs(
    headers: Record<string, unknown>,
    attempt: number,
  ): number {
    if (this.configService.get<string>('NODE_ENV') === 'test') {
      return 0;
    }

    const read = (key: string): string | undefined => {
      const val = headers[key] ?? headers[key.toLowerCase()];
      if (Array.isArray(val)) return typeof val[0] === 'string' ? val[0] : undefined;
      return typeof val === 'string' || typeof val === 'number'
        ? String(val)
        : undefined;
    };

    const retryAfter =
      read('x-sepay-userapi-retry-after') ?? read('retry-after');
    if (retryAfter) {
      const secs = Number.parseFloat(retryAfter);
      if (Number.isFinite(secs) && secs > 0) {
        return Math.min(30_000, Math.ceil(secs * 1000));
      }
    }

    const rateReset = read('x-ratelimit-reset');
    if (rateReset) {
      const resetVal = Number.parseFloat(rateReset);
      if (Number.isFinite(resetVal) && resetVal > 0) {
        // Handle Unix epoch seconds or relative seconds
        const diffMs =
          resetVal > 1_000_000_000
            ? resetVal * 1000 - Date.now()
            : resetVal * 1000;
        if (diffMs > 0) {
          return Math.min(30_000, Math.ceil(diffMs));
        }
      }
    }

    return Math.min(10_000, 1000 * 2 ** attempt);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
