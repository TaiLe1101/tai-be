import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { envSchema } from '~/configs/env.schema';
import { PrismaModule } from '~/modules/prisma/prisma.module';
import { RBACModule } from '~/modules/rbac/rbac.module';
import { AuthModule } from './modules/auth/auth.module';
import { RedisModule } from './modules/redis/redis.module';
import { AppReleasesModule } from './modules/app-releases/app-releases.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => envSchema.parse(config),
    }),
    PrismaModule,
    AuthModule,
    RedisModule,
    RBACModule,
    AppReleasesModule,
  ],
})
export class AppModule { }
