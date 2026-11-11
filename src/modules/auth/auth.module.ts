import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '~/modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '~/modules/auth/guards/permissions.guard';
import { JwtStrategy } from '~/modules/auth/strategies/jwt.strategy';
import { PrismaModule } from '~/modules/prisma/prisma.module';
import { RedisModule } from '~/modules/redis/redis.module';
import { SystemLogsModule } from '~/modules/system-logs/system-logs.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService,
    AuthService, JwtStrategy, PermissionsGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  imports: [SystemLogsModule, RedisModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return {
          secret: configService.get<string>('ACCESS_TOKEN_SECRET'),
        };
      },
    }),
  ],
})
export class AuthModule { }
