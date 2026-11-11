import { Body, Controller, Get, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDTO } from '~/modules/auth/dto/login.dto';
import { type ClientInfo, ClientInfoParam } from '~/common/decorators/client-info.decorator';
import { ResponseApi } from '~/types/response-api.type';
import type { Request, Response } from 'express';
import { JWT_KEY } from '~/common/constants/jwt-key.constant';
import { Public } from '~/common/decorators/public.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '~/modules/auth/decorators/current-user.decorator';
import type { User } from '$/prisma/browser';
import { AppRefreshTokenDTO } from '~/modules/auth/dto/app-refresh-token.dto';

@ApiBearerAuth('JWT-Auth')
@ApiTags("Đăng nhập tài khoản")
@Controller('auth')
export class AuthController {
  private readonly MAX_AGE_7_DAYS = 7 * 24 * 60 * 60 * 1000;
  constructor(private readonly authService: AuthService) { }

  @Public()
  @Post("/web/login")
  async login(@Body() reqBody: LoginDTO, @ClientInfoParam() clientInfo: ClientInfo, @Res({ passthrough: true }) res: Response) {


    const { accessToken, refreshToken } = await this.authService.login(reqBody, clientInfo);

    // Lưu vào cookie refreshToken
    res.cookie(JWT_KEY.REFRESH_TOKEN, refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: this.MAX_AGE_7_DAYS,
    });

    return new ResponseApi(HttpStatus.OK, 'LOGIN_SUCCESS', "Đăng nhập thành công", {
      accessToken
    })
  }

  @Public()
  @Post("/app/login")
  async mobileLogin(@Body() reqBody: LoginDTO, @ClientInfoParam() clientInfo: ClientInfo) {
    const result = await this.authService.login(reqBody, clientInfo);
    return new ResponseApi(HttpStatus.OK, 'LOGIN_SUCCESS', "Đăng nhập thành công", result)
  }


  @Get("/me")
  async me(@CurrentUser() currentUser: User) {
    const result = await this.authService.me(currentUser.id);
    return new ResponseApi(HttpStatus.OK, 'GET_CURRENT_USER_SUCCESS', "Lấy thông tin người dùng thành công", result)
  }

  @Public()
  @Post("/web/refresh")
  async webRefresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshTokenOld = req.cookies[JWT_KEY.REFRESH_TOKEN];

    const { accessToken, refreshToken } = await this.authService.refreshToken(refreshTokenOld);

    // Lưu vào cookie refreshToken
    res.cookie(JWT_KEY.REFRESH_TOKEN, refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: this.MAX_AGE_7_DAYS,
    });

    return new ResponseApi(HttpStatus.OK, 'REFRESH_TOKEN_SUCCESS', "Làm mới token thành công", {
      accessToken
    })
  }

  @Public()
  @Post("/app/refresh")
  async appRefresh(@Body() body: AppRefreshTokenDTO) {
    const result = await this.authService.refreshToken(body.refreshToken);
    return new ResponseApi(HttpStatus.OK, 'REFRESH_TOKEN_SUCCESS', "Làm mới token thành công", result)
  }

  @Post('/logout')
  async logout(@CurrentUser() user: User, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(user.id);

    res.cookie(JWT_KEY.REFRESH_TOKEN, '', {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 0,
    });

    return new ResponseApi(HttpStatus.OK, 'LOGOUT_SUCCESS', "Đăng xuất thành công")
  }
}
