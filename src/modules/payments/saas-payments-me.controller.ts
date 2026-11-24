import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '~/modules/auth/decorators/current-user.decorator';
import type { CurrentUserType } from '~/types/current-user.type';
import { ResponseApi } from '~/types/response-api.type';
import { SepayPaymentsService } from './sepay-payments.service';

@ApiBearerAuth('JWT-Auth')
@ApiTags('SaaS Payments (Desktop)')
@Controller('saas/me/payments')
export class SaasPaymentsMeController {
  constructor(private readonly paymentsService: SepayPaymentsService) {}

  @Get('config')
  @ApiOperation({ summary: 'Cấu hình thanh toán tự động SePay cho Desktop' })
  getConfig() {
    const data = this.paymentsService.getPaymentConfig();
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy cấu hình thanh toán thành công',
      data,
    );
  }

  @Post('orders')
  @ApiOperation({ summary: 'Tạo đơn thanh toán VietQR tự động' })
  async createOrder(
    @CurrentUser() user: CurrentUserType,
    @Body() body: { planId: number; billingCycle: 'MONTHLY' | 'YEARLY' },
  ) {
    const data = await this.paymentsService.createOrder(user.id, body);
    return new ResponseApi(
      HttpStatus.CREATED,
      'success',
      'Tạo mã QR thanh toán thành công',
      data,
    );
  }

  @Get('orders')
  @ApiOperation({ summary: 'Danh sách đơn thanh toán gần đây của Tenant' })
  async listOrders(@CurrentUser() user: CurrentUserType) {
    const data = await this.paymentsService.listTenantOrders(user.id);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách đơn thanh toán thành công',
      data,
    );
  }

  @Get('orders/:paymentCode/status')
  @ApiOperation({
    summary: 'Kiểm tra trạng thái đơn thanh toán (chỉ trả trạng thái & số tiền)',
  })
  async getOrderStatus(
    @CurrentUser() user: CurrentUserType,
    @Param('paymentCode') paymentCode: string,
  ) {
    const data = await this.paymentsService.getTenantOrderStatus(
      user.id,
      paymentCode,
    );
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy trạng thái đơn thanh toán thành công',
      data,
    );
  }

  @Post('orders/:paymentCode/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hủy đơn thanh toán đang chờ (PENDING)' })
  async cancelOrder(
    @CurrentUser() user: CurrentUserType,
    @Param('paymentCode') paymentCode: string,
  ) {
    const data = await this.paymentsService.cancelTenantOrder(
      user.id,
      paymentCode,
    );
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Đã hủy đơn thanh toán',
      data,
    );
  }
}
