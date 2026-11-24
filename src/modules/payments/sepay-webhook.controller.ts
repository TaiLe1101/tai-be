import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '~/common/decorators/public.decorator';
import { SepayPaymentsService } from './sepay-payments.service';
import type { SepayWebhookPayload } from './sepay-payments.types';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Public()
@ApiTags('SePay Webhook')
@Controller('payments/sepay')
export class SepayWebhookController {
  constructor(private readonly paymentsService: SepayPaymentsService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'SePay bank-transfer webhook endpoint (raw-body HMAC-SHA256 / Apikey verified)',
  })
  async receiveWebhook(
    @Req() req: RawBodyRequest,
    @Body() body: SepayWebhookPayload,
    @Res() res: Response,
  ) {
    const readHeader = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const isAuthorized = this.paymentsService.verifyWebhookRequest({
      timestampHeader: readHeader('x-sepay-timestamp'),
      signatureHeader: readHeader('x-sepay-signature'),
      authorizationHeader: readHeader('authorization'),
      rawBody: req.rawBody,
    });

    if (!isAuthorized) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Unauthorized',
      });
      return;
    }

    try {
      const result = await this.paymentsService.handleWebhook(body);
      res.status(HttpStatus.OK).json({ success: result.success });
    } catch {
      // Event not stored (e.g. DB down) -> 500 without stack trace or internal details so SePay retries.
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      });
    }
  }
}
