import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { envSchema } from '~/configs/env.schema';
import { PrismaModule } from '~/modules/prisma/prisma.module';
import { RBACModule } from '~/modules/rbac/rbac.module';
import { AuthModule } from './modules/auth/auth.module';
import { RedisModule } from './modules/redis/redis.module';
import { SystemLogsModule } from './modules/system-logs/system-logs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => envSchema.parse(config),
    }),
    PrismaModule,
    AuthModule,
    SystemLogsModule,
    RedisModule,
    RBACModule,
  ],
})
export class AppModule { }
