import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import crypto from 'crypto';
import { ClientInfo } from '~/common/decorators/client-info.decorator';
import { LoginDTO } from '~/modules/auth/dto/login.dto';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { RedisService } from '~/modules/redis/redis.service';
import { JwtPayload } from '~/types/jwt-payload.type';

@Injectable()
export class AuthService {
    private readonly TTL_REDIS_7_DAYS = 7 * 24 * 60 * 60;
    constructor(private readonly prisma: PrismaService, private readonly jwtService: JwtService, private readonly redisService: RedisService) { }

    async login(data: LoginDTO, clientInfo: ClientInfo = { ipAddress: 'Unknown' }) {

        const user = await this.validateUser(data.username, data.password, clientInfo);

        // Tạo access token và refresh token
        const payload: JwtPayload = {
            sub: {
                id: user.id
            }
        };

        const accessToken = this.generateAccessToken(payload)
        const refreshToken = this.generateRefreshToken();

        // Thực hiện xóa refresh token cũ
        const refreshTokenExist = await this.redisService.get<string>(`auth:${user.id}`);
        if (refreshTokenExist) {
            await this.redisService.del(`auth:${refreshTokenExist}`);
            await this.redisService.del(`auth:${user.id}`);
        }

        await this.redisService.set(`auth:${user.id}`, `${refreshToken}`, this.TTL_REDIS_7_DAYS);
        await this.redisService.set(`auth:${refreshToken}`, user.id, this.TTL_REDIS_7_DAYS);

        return {
            accessToken,
            refreshToken
        }
    }

    async validateUser(username: string, password: string, clientInfo: ClientInfo = { ipAddress: 'Unknown' }) {
        const user = await this.prisma.user.findUnique({
            where: {
                username
            },
        })

        if (!user) {
            throw new UnauthorizedException('Tài khoản hoặc mật khẩu không chính xác');
        }

        if (!user.isActive) {
            throw new ForbiddenException('Tài khoản đã bị khóa, Vui lòng liên hệ admin để giải quyết!');
        }

        const isVerified = await bcrypt.compare(password, user.password);

        if (!isVerified) {
            throw new UnauthorizedException('Tài khoản hoặc mật khẩu không chính xác');
        }
        return user;
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
        // Kiểm tra refresh token trong Redis
        const userId = await this.redisService.get<string>(`auth:${refreshToken}`);

        if (!userId) {
            throw new UnauthorizedException(
                'Refresh token không hợp lệ hoặc đã hết hạn',
            );
        }

        await this.redisService.del(`auth:${userId}`);
        await this.redisService.del(`auth:${refreshToken}`);

        // Tạo access token mới
        const accessToken = this.generateAccessToken({
            sub: {
                id: Number(userId),
            },
        });

        const newRefreshToken = this.generateRefreshToken();

        await this.redisService.set(`auth:${userId}`, `${newRefreshToken}`, this.TTL_REDIS_7_DAYS);
        await this.redisService.set(`auth:${newRefreshToken}`, userId, this.TTL_REDIS_7_DAYS);

        return {
            accessToken,
            refreshToken: newRefreshToken
        };
    }

    async me(userId: number) {
        const [user, permissions] = await Promise.all([
            // Query 1: Lấy user + roles sạch sẽ
            this.prisma.user.findUnique({
                where: { id: userId },
                include: {
                    userRoles: {
                        include: { role: true }
                    }
                }
            }),

            // Query 2: Lấy permissions duy nhất trực tiếp từ DB
            this.prisma.permission.findMany({
                where: {
                    isActive: true,
                    deletedAt: null,
                    rolePermissions: {
                        some: {
                            role: {
                                userRoles: {
                                    some: { userId }
                                }
                            }
                        }
                    }
                },
                orderBy: [{ group: 'asc' }, { code: 'asc' }]
            })
        ]);

        if (!user) {
            throw new UnauthorizedException("Người dùng không tồn tại, vui lòng đăng nhập lại!");
        }

        const roles = user.userRoles.map((ur) => ur.role);
        const { password, userRoles, ...profile } = user;
        
        return {
            profile,
            roles,
            permissions,
        };
    }

    async logout(userId: number) {
        const refreshToken = await this.redisService.get(`auth:${userId}`);
        if (refreshToken) {
            await this.redisService.del(`auth:${refreshToken}`);
            await this.redisService.del(`auth:${userId}`);
        } else {
            throw new UnauthorizedException("Chưa đăng nhập hoặc phiên đăng nhập hết hạn")
        }
    }
}

