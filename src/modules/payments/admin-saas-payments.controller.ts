import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminSaasGuard } from '~/modules/saas/guards/admin-saas.guard';
import { ResponseApi } from '~/types/response-api.type';
import { SepayPaymentsService } from './sepay-payments.service';

@ApiBearerAuth('JWT-Auth')
@ApiTags('Admin SePay Payments')
@UseGuards(AdminSaasGuard)
@Controller('admin/saas/payments')
export class AdminSaasPaymentsController {
  constructor(private readonly paymentsService: SepayPaymentsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Tổng quan thanh toán SePay & trạng thái đối soát' })
  async summary() {
    const data = await this.paymentsService.getAdminSummary();
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy tổng quan thanh toán SePay thành công',
      data,
    );
  }

  @Get('orders')
  @ApiOperation({ summary: 'Danh sách đơn thanh toán SePay (phân trang)' })
  async listOrders(
    @Query()
    query: {
      page?: string;
      limit?: string;
      status?: string;
      search?: string;
    },
  ) {
    const { data, pagination } =
      await this.paymentsService.listAdminOrders(query);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách đơn thanh toán thành công',
      data,
      pagination,
    );
  }

  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin hủy đơn thanh toán đang PENDING' })
  async cancelOrder(@Param('id', ParseIntPipe) id: number) {
    const data = await this.paymentsService.cancelAdminOrder(id);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Đã hủy đơn thanh toán',
      data,
    );
  }

  @Post('orders/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Đối soát thủ công một đơn thanh toán qua SePay API v2',
  })
  async reconcileOrder(@Param('id', ParseIntPipe) id: number) {
    const data = await this.paymentsService.reconcileOrderById(id);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      data.matched
        ? 'Đã tìm thấy giao dịch khớp và kích hoạt gói'
        : 'Chưa tìm thấy giao dịch khớp trên SePay',
      data,
    );
  }

  @Get('events')
  @ApiOperation({
    summary: 'Danh sách sự kiện Webhook SePay & giao dịch cần đối soát/hoàn tiền',
  })
  async listEvents(
    @Query()
    query: {
      page?: string;
      limit?: string;
      status?: string;
      search?: string;
    },
  ) {
    const { data, pagination } =
      await this.paymentsService.listAdminEvents(query);
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách sự kiện Webhook SePay thành công',
      data,
      pagination,
    );
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Chạy đối soát định kỳ SePay API v2 ngay lập tức' })
  async runReconcile() {
    const data = await this.paymentsService.runRoutineReconciliation();
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Chạy đối soát SePay thành công',
      data,
    );
  }
}
