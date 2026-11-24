import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AppLoginDTO {
  @ApiPropertyOptional({
    description: 'Tên đăng nhập hoặc email',
    example: 'user@example.com',
  })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({
    description: 'Email đăng nhập (tùy chọn thay cho username)',
    example: 'user@example.com',
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ description: 'Mật khẩu', example: '123456' })
  @IsNotEmpty({ message: 'Vui lòng nhập mật khẩu' })
  @IsString()
  password: string;
}
