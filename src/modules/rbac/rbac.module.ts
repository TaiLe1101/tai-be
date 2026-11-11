import { Module } from '@nestjs/common';
import { RBACController } from '~/modules/rbac/rbac.controller';
import { RBACService } from './rbac.service';

@Module({
  controllers: [RBACController],
  providers: [RBACService],
})
export class RBACModule { }
