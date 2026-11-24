import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { SaasModule } from '~/modules/saas/saas.module';
import { AdminSaasPaymentsController } from './admin-saas-payments.controller';
import { SaasPaymentsMeController } from './saas-payments-me.controller';
import { SepayApiClient } from './sepay-api.client';
import { SepayPaymentsService } from './sepay-payments.service';
import { SepayWebhookController } from './sepay-webhook.controller';

@Module({
  imports: [HttpModule, SaasModule],
  controllers: [
    SepayWebhookController,
    SaasPaymentsMeController,
    AdminSaasPaymentsController,
  ],
  providers: [SepayApiClient, SepayPaymentsService],
  exports: [SepayPaymentsService],
})
export class PaymentsModule {}
