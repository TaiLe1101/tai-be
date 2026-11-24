import { Module } from '@nestjs/common';
import { AdminSaasController } from './admin-saas.controller';
import { AdminSaasGuard } from './guards/admin-saas.guard';
import { PublicPlansController } from './public-plans.controller';
import { SaasEntitlementService } from './saas-entitlement.service';
import { SaasMeController } from './saas-me.controller';
import { SaasSeedService } from './saas-seed.service';
import { SaasService } from './saas.service';

@Module({
  controllers: [PublicPlansController, SaasMeController, AdminSaasController],
  providers: [
    SaasSeedService,
    SaasEntitlementService,
    SaasService,
    AdminSaasGuard,
  ],
  exports: [SaasSeedService, SaasEntitlementService, SaasService],
})
export class SaasModule {}
