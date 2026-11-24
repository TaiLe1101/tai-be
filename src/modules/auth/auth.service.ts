import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import crypto from 'crypto';
import { ClientInfo } from '~/common/decorators/client-info.decorator';
import { AppLoginDTO } from '~/modules/auth/dto/app-login.dto';
import { AppRegisterDTO } from '~/modules/auth/dto/app-register.dto';
import { LoginDTO } from '~/modules/auth/dto/login.dto';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { RedisService } from '~/modules/redis/redis.service';
import { SaasEntitlementService } from '~/modules/saas/saas-entitlement.service';
import type { UserSummaryDto } from '~/modules/saas/saas.types';
import { JwtPayload } from '~/types/jwt-payload.type';

@Injectable()
export class AuthService {
  private readonly TTL_REDIS_7_DAYS = 7 * 24 * 60 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly entitlementService?: SaasEntitlementService,
  ) {}

  async login(data: LoginDTO, clientInfo: ClientInfo = { ipAddress: 'Unknown' }) {
    const user = await this.validateUser(data.username, data.password, clientInfo);
    return this.issueTokens(user.id);
  }

  async appLogin(
    data: AppLoginDTO,
    clientInfo: ClientInfo = { ipAddress: 'Unknown' },
  ) {
    const identifier = (data.username || data.email || '').trim();
    if (!identifier) {
      throw new BadRequestException('Vui lòng nhập email hoặc tên đăng nhập');
    }

    const user = await this.validateUser(identifier, data.password, clientInfo);
    const tokens = await this.issueTokens(user.id);
    const entitlement = this.entitlementService
      ? await this.entitlementService.getUserEntitlement(user.id, {
          createIfMissing: !user.isRoot,
        })
      : null;

    return {
      ...tokens,
      user: this.toUserSummary(user),
      entitlement,
    };
  }

  async appRegister(data: AppRegisterDTO) {
    const email = data.email.trim().toLowerCase();
    const username = (data.username?.trim() || email).toLowerCase();
    const firstName = data.firstName.trim();
    const lastName = (data.lastName ?? '').trim();

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: email, mode: 'insensitive' } },
          { username: { equals: username, mode: 'insensitive' } },
        ],
      },
    });

    if (existing) {
      if (existing.email?.toLowerCase() === email) {
        throw new ConflictException('Email này đã được đăng ký');
      }
      throw new ConflictException('Tên đăng nhập này đã được sử dụng');
    }

    const saltRounds = Number(this.configService?.get<number>('SALT_ROUNDS') || 10);
    const passwordHash = await bcrypt.hash(data.password, saltRounds);

    const user = await this.prisma.user.create({
      data: {
        username,
        email,
        password: passwordHash,
        firstName,
        lastName,
        isActive: true,
        isRoot: false,
      },
    });

    const entitlement = this.entitlementService
      ? await this.entitlementService.ensurePersonalTenantForUser(user.id, {
          tenantName: data.tenantName,
          contactEmail: email,
          fallbackName: `${firstName} ${lastName}`.trim() || username,
        })
      : null;

    const tokens = await this.issueTokens(user.id);

    return {
      ...tokens,
      user: this.toUserSummary(user),
      entitlement,
    };
  }

  async validateUser(
    identifier: string,
    password: string,
    _clientInfo: ClientInfo = { ipAddress: 'Unknown' },
  ) {
    void _clientInfo;
    const trimmed = identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { username: trimmed },
          { email: { equals: trimmed.toLowerCase(), mode: 'insensitive' } },
        ],
      },
    });

    if (!user) {
      throw new UnauthorizedException('Tài khoản hoặc mật khẩu không chính xác');
    }

    if (!user.isActive) {
      throw new ForbiddenException(
        'Tài khoản đã bị khóa, Vui lòng liên hệ admin để giải quyết!',
      );
    }

    const isVerified = await bcrypt.compare(password, user.password);

    if (!isVerified) {
      throw new UnauthorizedException('Tài khoản hoặc mật khẩu không chính xác');
    }
    return user;
  }

  private async issueTokens(userId: number) {
    const payload: JwtPayload = {
      sub: {
        id: userId,
      },
    };

    const accessToken = this.generateAccessToken(payload);
    const refreshToken = this.generateRefreshToken();

    // Remove previous refresh token
    const refreshTokenExist = await this.redisService.get<string>(`auth:${userId}`);
    if (refreshTokenExist) {
      await this.redisService.del(`auth:${refreshTokenExist}`);
      await this.redisService.del(`auth:${userId}`);
    }

    await this.redisService.set(`auth:${userId}`, `${refreshToken}`, this.TTL_REDIS_7_DAYS);
    await this.redisService.set(`auth:${refreshToken}`, userId, this.TTL_REDIS_7_DAYS);

    return {
      accessToken,
      refreshToken,
    };
  }

  private toUserSummary(user: {
    id: number;
    username: string;
    email?: string | null;
    firstName: string;
    lastName: string;
    isActive: boolean;
    isRoot: boolean;
  }): UserSummaryDto {
    return {
      id: user.id,
      username: user.username,
      email: user.email ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      isActive: user.isActive,
      isRoot: user.isRoot,
    };
  }

  private generateAccessToken(payload: JwtPayload) {
    return this.jwtService.sign(payload, {
      expiresIn: '1d',
    });
  }

  private generateRefreshToken() {
    return crypto.randomBytes(64).toString('hex');
  }

  async refreshToken(refreshToken: string) {
    const userId = await this.redisService.get<string>(`auth:${refreshToken}`);

    if (!userId) {
      throw new UnauthorizedException(
        'Refresh token không hợp lệ hoặc đã hết hạn',
      );
    }

    await this.redisService.del(`auth:${userId}`);
    await this.redisService.del(`auth:${refreshToken}`);

    const accessToken = this.generateAccessToken({
      sub: {
        id: Number(userId),
      },
    });

    const newRefreshToken = this.generateRefreshToken();

    await this.redisService.set(
      `auth:${userId}`,
      `${newRefreshToken}`,
      this.TTL_REDIS_7_DAYS,
    );
    await this.redisService.set(
      `auth:${newRefreshToken}`,
      userId,
      this.TTL_REDIS_7_DAYS,
    );

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  async me(userId: number) {
    const [user, permissions] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          userRoles: {
            include: { role: true },
          },
        },
      }),
      this.prisma.permission.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          rolePermissions: {
            some: {
              role: {
                userRoles: {
                  some: { userId },
                },
              },
            },
          },
        },
        orderBy: [{ group: 'asc' }, { code: 'asc' }],
      }),
    ]);

    if (!user) {
      throw new UnauthorizedException(
        'Người dùng không tồn tại, vui lòng đăng nhập lại!',
      );
    }

    const entitlement = this.entitlementService
      ? await this.entitlementService.getUserEntitlement(user.id, {
          createIfMissing: !user.isRoot,
        })
      : null;

    const roles = user.userRoles.map((ur) => ur.role);
    const { password: _password, userRoles: _userRoles, ...profile } = user;
    void _password;
    void _userRoles;

    return {
      profile,
      roles,
      permissions,
      entitlement,
    };
  }

  async logout(userId: number) {
    const refreshToken = await this.redisService.get(`auth:${userId}`);
    if (refreshToken) {
      await this.redisService.del(`auth:${refreshToken}`);
      await this.redisService.del(`auth:${userId}`);
    } else {
      throw new UnauthorizedException(
        'Chưa đăng nhập hoặc phiên đăng nhập hết hạn',
      );
    }
  }
}
