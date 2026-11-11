import { PrismaClient } from '$/prisma/client';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy {
  // Add logger
  private readonly logger: Logger = new Logger(PrismaService.name);

  constructor(private readonly configService: ConfigService) {
    const adapter = new PrismaPg({
      host: configService.get<string>('DB_HOST'),
      port: configService.get<number>('DB_PORT'),
      user: configService.get<string>('DB_USER'),
      password: configService.get<string>('DB_PASS'),
      database: configService.get<string>('DB_NAME'),
    });
    super({ adapter });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      await this.$queryRawUnsafe('SELECT 1');
      
      // Gửi một truy vấn kiểm tra kết nối thực tế tới PostgreSQL
      this.logger.log('Đã kết nối thành công với PostgreSQL');
    } catch (error) {
      this.logger.error('Lỗi kết nối với PostgreSQL. Vui lòng kiểm tra database server!', error);
      throw error;
    }
  }


  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Đã ngắt kết nối với Prisma');
  }
}
