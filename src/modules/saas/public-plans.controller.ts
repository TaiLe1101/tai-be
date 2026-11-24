import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '~/common/decorators/public.decorator';
import { ResponseApi } from '~/types/response-api.type';
import { SaasService } from './saas.service';

@Public()
@ApiTags('Public SaaS')
@Controller('public')
export class PublicPlansController {
  constructor(private readonly saasService: SaasService) {}

  @Get('plans')
  @ApiOperation({ summary: 'Danh sách gói dịch vụ công khai' })
  async listPlans(@Res({ passthrough: true }) response: Response) {
    const plans = await this.saasService.listPublicPlans();
    response.removeHeader('Access-Control-Allow-Credentials');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'public, max-age=60');
    return new ResponseApi(
      HttpStatus.OK,
      'success',
      'Lấy danh sách gói dịch vụ thành công',
      plans,
    );
  }
}
