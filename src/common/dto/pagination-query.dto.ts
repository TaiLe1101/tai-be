import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginationQueryDTO {
  @ApiPropertyOptional({
    example: 1,
    description: 'Số trang (bắt đầu từ 1)',
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page phải là số nguyên' })
  @Min(1, { message: 'page tối thiểu là 1' })
  page?: number = 1;

  @ApiPropertyOptional({
    example: 10,
    description: 'Số lượng bản ghi mỗi trang (tối đa 100)',
    default: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit phải là số nguyên' })
  @Min(1, { message: 'limit tối thiểu là 1' })
  @Max(100, { message: 'limit tối đa là 100' })
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Từ khóa tìm kiếm',
  })
  @IsOptional()
  @IsString({ message: 'search phải là chuỗi' })
  search?: string;

  @ApiPropertyOptional({
    description: 'Trường sắp xếp',
  })
  @IsOptional()
  @IsString({ message: 'sortBy phải là chuỗi' })
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({
    description: 'Chiều sắp xếp (asc hoặc desc)',
    enum: ['asc', 'desc'],
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'sortOrder phải là asc hoặc desc' })
  sortOrder?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({
    description: "Tìm kiếm",
  })
  @IsOptional()
  q?: string
}
