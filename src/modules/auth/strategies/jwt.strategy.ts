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
    console.log(payload)
    const user = await this.prismaService.user.findFirst(
      {
        where: {
          id: Number(payload.sub.id)
        }
      }
    );

    if (!user) {
      throw new UnauthorizedException('Người dùng không tồn tại');
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'Tài khoản người dùng bị khóa',
      );
    }

    // const permissions: string[] =
    //   user.role?.permissions?.map((p) => p.permission.code) ?? [];

    // const { role, ...restUser } = user;

    return user;
  }
}
