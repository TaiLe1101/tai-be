import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { JwtPayload } from '~/types/jwt-payload.type';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('ACCESS_TOKEN_SECRET')!,
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prismaService.user.findFirst({
      where: {
        id: Number(payload.sub.id),
        deletedAt: null,
      },
      omit: { password: true },
      include: {
        userRoles: {
          where: { role: { isActive: true, deletedAt: null } },
          include: {
            role: {
              include: {
                rolePermissions: {
                  where: { permission: { isActive: true, deletedAt: null } },
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Người dùng không tồn tại');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Tài khoản người dùng bị khóa');
    }

    const { userRoles, ...profile } = user;
    const permissions = [
      ...new Set(
        userRoles.flatMap(({ role }) =>
          role.rolePermissions.map(({ permission }) => permission.code),
        ),
      ),
    ];
    return { ...profile, permissions };
  }
}
