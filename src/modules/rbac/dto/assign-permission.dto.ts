import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayNotEmpty, IsArray, IsInt } from "class-validator";

export class AssignPermissionDTO {

    @ApiProperty({
        description: "Danh sách id quyền hạn",
        type: [Number]
    })
    @IsArray({
        message: "Phải là danh sách id",

    })
    @IsInt({ each: true, message: 'Mỗi id phải là một số nguyên' })
    @Type(() => Number)
    permissionIds: number[]
}