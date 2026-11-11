import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginationQueryDTO } from '~/common/dto/pagination-query.dto';
import { ResponseApi } from '~/types/response-api.type';
import { RBACService } from './rbac.service';
import { CreateRoleDTO } from '~/modules/rbac/dto/create-role.dto';
import { UpdateRoleDTO } from '~/modules/rbac/dto/update-role.dto';
import { AssignPermissionDTO } from '~/modules/rbac/dto/assign-permission.dto';

@ApiBearerAuth('JWT-Auth')
@ApiTags("Vai trò hệ thống và phân quyền hạn")
@Controller('rbac')
export class RBACController {
  constructor(private readonly rolesService: RBACService) { }

  @Get("/roles")
  @ApiOperation({ summary: "Lấy danh sách vai trò" })
  async index(@Query() q: PaginationQueryDTO) {
    const { data, pagination, meta } = await this.rolesService.findAll(q)
    return new ResponseApi(HttpStatus.OK, "GET_ALL_ROLE_SUCCESS", "Lấy danh sách vai trò thành công", data, pagination, meta)
  }

  @Post("/roles")
  @ApiOperation({ summary: "Tạo vai trò mới" })
  async create(@Body() body: CreateRoleDTO) {
    const result = await this.rolesService.create(body)
    return new ResponseApi(HttpStatus.OK, "CREATE_ROLE_SUCCESS", "Thêm vai trò mới thành công", result)
  }

  @Put("/roles/:id")
  @ApiOperation({ summary: "Cập nhật vai trò" })
  async update(@Param("id", ParseIntPipe) id: number, @Body() body: UpdateRoleDTO) {
    const result = await this.rolesService.update(id, body);
    return new ResponseApi(HttpStatus.OK, "UPDATE_ROLE_SUCCESS", "Cập nhật vai trò thành công", result)
  }

  @Delete("/roles/:id")
  @ApiOperation({ summary: "Xóa vai trò" })
  async delete(@Param("id", ParseIntPipe) id: number) {
    const result = await this.rolesService.delete(id);
    return new ResponseApi(HttpStatus.OK, "DELETE_ROLE_SUCCESS", "Xóa vai trò thành công", result)
  }

  @Get("/roles/detail/:id")
  @ApiOperation({ summary: "Chi tiết vai trò" })
  async detail(@Param("id", ParseIntPipe) id: number) {
    const result = await this.rolesService.findById(id)
    return new ResponseApi(HttpStatus.OK, "DETAIL_ROLE_SUCCESS", "Chi tiết vai trò thành công", result)
  }

  @ApiOperation({ summary: "Phân quyền cho vai trò" })
  @Put("/roles/assign/:id")
  async assignPermission(@Param("id", ParseIntPipe) id: number, @Body() body: AssignPermissionDTO) {
    const result = await this.rolesService.assignPermission(id, body);
    return new ResponseApi(HttpStatus.OK, "ASSIGN_PERMISSION_SUCCESS", "Phần quyền cho vai trò hệ thống thành công", result)
  }

  @ApiOperation({ summary: "Lấy danh sách vai trò" })
  @Get("/permissions")
  async getPermissions() {
    const result = await this.rolesService.getPermissions();
    return new ResponseApi(HttpStatus.OK, "GET_PERMISSIONS_SUCCESS", "Lấy danh sách quyền hạn thành công", result)
  }

  @ApiOperation({ summary: "Làm mới vai trò" })
  @Post("/permissions/refresh")
  async refreshPermissions() {
    const result = await this.rolesService.refreshPermissions();
    return new ResponseApi(HttpStatus.OK, "REFRESH_SUCCESS", "Làm mới quyền hạn thành công", result)
  }

}
