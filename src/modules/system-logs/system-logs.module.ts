import { Module } from '@nestjs/common';
import { SystemLogsService } from './system-logs.service';
import { SystemLogsController } from './system-logs.controller';
import { PrismaModule } from '~/modules/prisma/prisma.module';

@Module({
  controllers: [SystemLogsController],
  providers: [SystemLogsService],
  imports: [PrismaModule],
  exports: [SystemLogsService]
})
export class SystemLogsModule { }
