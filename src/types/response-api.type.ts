import { PaginationType } from '~/types/pagination.type';

export class ResponseApi<DT, MT = never> {
  statusCode: number;
  status: string;
  message: string;
  data: DT | null;
  pagination: PaginationType | null;
  meta: MT | null;

  constructor(
    statusCode: number,
    status: string,
    message: string,
    data?: DT | null,
    pagination?: PaginationType | null,
    meta?: MT | null,
  ) {
    this.statusCode = statusCode;
    this.status = status;
    this.message = message;
    this.data = data ?? null;
    this.pagination = pagination ?? null;
    this.meta = meta ?? null;
  }
}
