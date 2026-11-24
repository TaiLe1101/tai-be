import { Body, Controller, Get, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '~/modules/auth/decorators/current-user.decorator';
import type { CurrentUserType } from '~/types/current-user.type';
import { ResponseApi } from '~/types/response-api.type';
import { SaasEntitlementService } from './saas-entitlement.service';
import { SaasService } from './saas.service';

@ApiBearerAuth('JWT-Auth')
@ApiTags('SaaS Account (Desktop)')
@Controller('saas/me')
export class SaasMeController {
  constructor(
    private readonly entitlementService: SaasEntitlementService,
    private readonly saasService: SaasService,
  ) {}

  @Get('entitlement')
  @ApiOperation({ summary: 'Lấy thông tin Tenant, gói và hạn mức hiện tại' })
  async getEntitlement(@CurrentUser() user: CurrentUserType) {
    const entitlement = await this.entitlementService.getUserEntitlement(
      user.id,
      { createIfMissing: true },
    );
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy thông tin gói dịch vụ thành công',
      entitlement,
    );
  }

  @Get('upgrade-requests')
  @ApiOperation({ summary: 'Danh sách yêu cầu nâng cấp của Tenant hiện tại' })
  async listUpgradeRequests(@CurrentUser() user: CurrentUserType) {
    const requests = await this.saasService.listMyUpgradeRequests(user.id);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách yêu cầu nâng cấp thành công',
      requests,
    );
  }

  @Post('upgrade-requests')
  @ApiOperation({ summary: 'Gửi yêu cầu nâng cấp gói cho quản trị viên duyệt' })
  async createUpgradeRequest(
    @CurrentUser() user: CurrentUserType,
    @Body()
    body: {
      planId: number;
      billingCycle?: 'MONTHLY' | 'YEARLY';
      contactNote?: string;
    },
  ) {
    const created = await this.saasService.createMyUpgradeRequest(
      user.id,
      body,
    );
    return new ResponseApi(
      HttpStatus.CREATED,
      'success',
      'Đã gửi yêu cầu nâng cấp gói thành công',
      created,
    );
  }
}
