import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ResponseApi } from '~/types/response-api.type';
import { AdminSaasGuard } from './guards/admin-saas.guard';
import { SaasService } from './saas.service';
import type {
  BillingCycleValue,
  TenantMemberRoleValue,
  TenantStatusValue,
  TenantTypeValue,
} from './saas.types';

@ApiBearerAuth('JWT-Auth')
@ApiTags('Admin SaaS Management')
@UseGuards(AdminSaasGuard)
@Controller('admin/saas')
export class AdminSaasController {
  constructor(private readonly saasService: SaasService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Tổng quan SaaS (Tenant, gói, sử dụng, yêu cầu)' })
  async overview() {
    const data = await this.saasService.getAdminOverview();
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy tổng quan SaaS thành công',
      data,
    );
  }

  @Get('plans')
  @ApiOperation({ summary: 'Danh sách toàn bộ gói dịch vụ' })
  async listPlans() {
    const data = await this.saasService.listAdminPlans();
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách gói thành công',
      data,
    );
  }

  @Post('plans')
  @ApiOperation({ summary: 'Tạo gói dịch vụ mới' })
  async createPlan(
    @Body()
    body: {
      code: string;
      name: string;
      description?: string | null;
      badge?: string | null;
      priceMonthly: number;
      priceYearly: number;
      currency?: string;
      monthlyMinutesLimit?: number | null;
      maxSeats: number;
      features?: string[];
      isPublic?: boolean;
      isDefault?: boolean;
      isHighlighted?: boolean;
      sortOrder?: number;
      isActive?: boolean;
    },
  ) {
    const data = await this.saasService.createAdminPlan(body);
    return new ResponseApi(
      HttpStatus.CREATED,
      'success',
      'Tạo gói dịch vụ thành công',
      data,
    );
  }

  @Put('plans/:id')
  @ApiOperation({ summary: 'Cập nhật gói dịch vụ' })
  async updatePlan(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    const data = await this.saasService.updateAdminPlan(id, body);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Cập nhật gói dịch vụ thành công',
      data,
    );
  }

  @Delete('plans/:id')
  @ApiOperation({ summary: 'Xóa mềm gói dịch vụ' })
  async deletePlan(@Param('id', ParseIntPipe) id: number) {
    const data = await this.saasService.deleteAdminPlan(id);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Xóa gói dịch vụ thành công',
      data,
    );
  }

  @Get('tenants')
  @ApiOperation({ summary: 'Danh sách Tenant có phân trang & bộ lọc' })
  async listTenants(
    @Query()
    query: {
      page?: string;
      limit?: string;
      search?: string;
      type?: string;
      status?: string;
      planId?: string;
    },
  ) {
    const { data, pagination } = await this.saasService.listAdminTenants(query);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách Tenant thành công',
      data,
      pagination,
    );
  }

  @Get('tenants/:id')
  @ApiOperation({ summary: 'Chi tiết Tenant, thành viên, gói và lịch sử dùng' })
  async getTenantDetail(@Param('id', ParseIntPipe) id: number) {
    const data = await this.saasService.getAdminTenantDetail(id);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy chi tiết Tenant thành công',
      data,
    );
  }

  @Post('tenants')
  @ApiOperation({ summary: 'Tạo mới Tenant' })
  async createTenant(
    @Body()
    body: {
      name: string;
      code?: string;
      type?: TenantTypeValue;
      contactEmail?: string | null;
      notes?: string | null;
      ownerUserId?: number;
      initialPlanId?: number;
      billingCycle?: BillingCycleValue;
      durationDays?: number | null;
      expiresAt?: string | null;
    },
  ) {
    const data = await this.saasService.createAdminTenant(body);
    return new ResponseApi(
      HttpStatus.CREATED,
      'success',
      'Tạo Tenant thành công',
      data,
    );
  }

  @Put('tenants/:id')
  @ApiOperation({ summary: 'Cập nhật thông tin / trạng thái Tenant' })
  async updateTenant(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      name?: string;
      status?: TenantStatusValue;
      type?: TenantTypeValue;
      contactEmail?: string | null;
      notes?: string | null;
    },
  ) {
    const data = await this.saasService.updateAdminTenant(id, body);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Cập nhật Tenant thành công',
      data,
    );
  }

  @Post('tenants/:id/members')
  @ApiOperation({ summary: 'Thêm hoặc cập nhật vai trò thành viên Tenant' })
  async addMember(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      userId?: number;
      identifier?: string;
      role?: TenantMemberRoleValue;
    },
  ) {
    const data = await this.saasService.addAdminTenantMember(id, body);
    return new ResponseApi(
      HttpStatus.CREATED,
      'success',
      'Cập nhật thành viên Tenant thành công',
      data,
    );
  }

  @Delete('tenants/:id/members/:userId')
  @ApiOperation({ summary: 'Xóa thành viên khỏi Tenant' })
  async removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    const data = await this.saasService.removeAdminTenantMember(id, userId);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Xóa thành viên thành công',
      data,
    );
  }

  @Post('tenants/:id/subscriptions')
  @ApiOperation({ summary: 'Gán / nâng cấp / gia hạn gói cho Tenant' })
  async assignSubscription(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      planId: number;
      billingCycle?: BillingCycleValue;
      startsAt?: string;
      expiresAt?: string | null;
      durationDays?: number | null;
      monthlyMinutesLimitOverride?: number | null;
      note?: string;
    },
  ) {
    const data = await this.saasService.assignAdminTenantSubscription(id, body);
    return new ResponseApi(
      HttpStatus.CREATED,
      'success',
      'Cập nhật gói dịch vụ cho Tenant thành công',
      data,
    );
  }

  @Put('tenants/:id/usage/reset')
  @ApiOperation({ summary: 'Đặt lại hạn mức đã dùng của Tenant trong tháng' })
  async resetUsage(
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { period?: string },
  ) {
    const data = await this.saasService.resetAdminTenantUsage(id, body);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Đặt lại hạn mức sử dụng thành công',
      data,
    );
  }

  @Get('upgrade-requests')
  @ApiOperation({ summary: 'Danh sách yêu cầu nâng cấp gói' })
  async listUpgradeRequests(
    @Query() query: { page?: string; limit?: string; status?: string },
  ) {
    const { data, pagination } =
      await this.saasService.listAdminUpgradeRequests(query);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách yêu cầu nâng cấp thành công',
      data,
      pagination,
    );
  }

  @Post('upgrade-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Duyệt yêu cầu nâng cấp và kích hoạt gói mới' })
  async approveUpgradeRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body?: {
      durationDays?: number;
      expiresAt?: string | null;
      monthlyMinutesLimitOverride?: number | null;
      adminNote?: string;
    },
  ) {
    const data = await this.saasService.approveAdminUpgradeRequest(id, body);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Duyệt yêu cầu nâng cấp thành công',
      data,
    );
  }

  @Post('upgrade-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Từ chối yêu cầu nâng cấp' })
  async rejectUpgradeRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() body?: { adminNote?: string },
  ) {
    const data = await this.saasService.rejectAdminUpgradeRequest(id, body);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Từ chối yêu cầu nâng cấp thành công',
      data,
    );
  }

  @Get('users')
  @ApiOperation({ summary: 'Tìm kiếm người dùng cho quản trị SaaS' })
  async listUsers(
    @Query() query: { page?: string; limit?: string; search?: string },
  ) {
    const { data, pagination } = await this.saasService.listAdminUsers(query);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách người dùng thành công',
      data,
      pagination,
    );
  }
}
