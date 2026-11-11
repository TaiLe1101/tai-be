import { ApiProperty } from "@nestjs/swagger";
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateRoleDTO {
    @ApiProperty({
        description: "Mã vai trò"
    })
    @IsString()
    @IsNotEmpty({ message: "Mã vai trò không được bỏ trống" })
    code: string

    @ApiProperty({
        description: "Tên vai trò"
    })
    @IsString()
    @IsNotEmpty({ message: "Tên vai trò không được bỏ trống" })
    name: string

    @ApiProperty({
        description: "Mô tả vai trò"
    })
    @IsOptional()
    description?: string

    @ApiProperty({ type: [Number] })
    @IsArray({ message: "Phải là mảng id" })
    @IsOptional()
    userIds?: number[]

    @ApiProperty({ type: [Number] })
    @IsArray({ message: "Phải là mảng id" })
    @ArrayNotEmpty()
    permissionIds: number[]
}