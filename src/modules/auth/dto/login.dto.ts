import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class LoginDTO {
    @ApiProperty({ description: 'Tên đăng nhập', type: 'string', example: 'root' })
    @IsNotEmpty()
    @IsString()
    username: string;

    @ApiProperty({ description: 'Mật khẩu', type: 'string', example: '123456' })
    @IsNotEmpty()
    @IsString()
    password: string;
}