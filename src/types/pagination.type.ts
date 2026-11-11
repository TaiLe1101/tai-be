import { ApiProperty } from '@nestjs/swagger';

export class PaginationType {
  @ApiProperty({ example: 1, description: 'Trang hiện tại' })
  page: number;

  @ApiProperty({ example: 10, description: 'Số bản ghi trên một trang' })
  limit: number;

  @ApiProperty({ example: 5, description: 'Tổng số trang' })
  totalPage: number;

  @ApiProperty({ example: 50, description: 'Tổng số bản ghi' })
  totalItems: number;
}
