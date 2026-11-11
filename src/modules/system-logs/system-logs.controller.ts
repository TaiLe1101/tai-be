import { Controller } from '@nestjs/common';
import { SystemLogsService } from './system-logs.service';

@Controller('system-logs')
export class SystemLogsController {
  constructor(private readonly systemLogsService: SystemLogsService) {}
}
