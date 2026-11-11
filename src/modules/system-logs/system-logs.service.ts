import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { CreateLoginLogInputDTO } from '~/modules/system-logs/dto/create-login-log-input.dto';

@Injectable()
export class SystemLogsService {
    private readonly logger = new Logger(SystemLogsService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Ghi nhận lịch sử đăng nhập vào database.
     * Được bọc try/catch để đảm bảo không làm gián đoạn luồng login nếu có sự cố DB.
     */
    async record(data: CreateLoginLogInputDTO): Promise<void> {
        try {
            await this.prisma.userLoginLog.create({
                data: {
                    username: data.username ?? null,
                    ipAddress: data.ipAddress,
                    userAgent: data.userAgent ?? null,
                    device: data.device ?? null,
                    status: data.status,
                    failureReason: data.failureReason ?? null,
                },
            });
        } catch (error) {
            this.logger.error(
                'Không thể ghi nhận log đăng nhập vào database:',
                error,
            );
        }
    }
}
