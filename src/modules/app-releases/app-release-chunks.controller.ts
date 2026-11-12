import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { Public } from '~/common/decorators/public.decorator';
import { ResponseApi } from '~/types/response-api.type';
import {
  AppReleaseChunksService,
  RELEASE_CHUNK_SIZE,
} from './app-release-chunks.service';

@ApiTags('Phiên bản desktop app')
@Controller('app-releases/uploads')
export class AppReleaseChunksController {
  constructor(private readonly chunks: AppReleaseChunksService) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Tạo phiên upload chia phần, hết hạn sau 24 giờ' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'object',
          example: {
            manifest: { name: 'latest.yml', size: 512 },
            installer: { name: 'setup.exe', size: 157286400 },
            blockmap: { name: 'setup.exe.blockmap', size: 1024 },
          },
        },
      },
    },
  })
  async create(@Body() body: unknown) {
    return new ResponseApi(
      HttpStatus.CREATED,
      'CREATE_RELEASE_UPLOAD_SUCCESS',
      'Đã tạo phiên upload',
      await this.chunks.create(body),
    );
  }

  @Public()
  @Put(':uploadId/:field/:index')
  @ApiOperation({
    summary: 'Upload một phần; gửi lại cùng chỉ số để thử lại an toàn',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['chunk'],
      properties: { chunk: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: memoryStorage(),
      // Busboy fires its size limit at equality; the service enforces exact size.
      limits: {
        fileSize: RELEASE_CHUNK_SIZE + 1,
        files: 1,
        fields: 0,
        parts: 2,
      },
    }),
  )
  async chunk(
    @Param('uploadId') id: string,
    @Param('field') field: string,
    @Param('index', ParseIntPipe) index: number,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return new ResponseApi(
      HttpStatus.OK,
      'UPLOAD_RELEASE_CHUNK_SUCCESS',
      'Đã nhận phần upload',
      await this.chunks.chunk(id, field, index, file),
    );
  }

  @Public()
  @Post(':uploadId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ghép các phần, kiểm tra checksum và tạo bản nháp' })
  async complete(@Param('uploadId') id: string) {
    return new ResponseApi(
      HttpStatus.OK,
      'UPLOAD_APP_RELEASE_SUCCESS',
      'Tạo bản nháp thành công',
      await this.chunks.complete(id),
    );
  }

  @Public()
  @Delete(':uploadId')
  async cancel(@Param('uploadId') id: string) {
    return new ResponseApi(
      HttpStatus.OK,
      'CANCEL_RELEASE_UPLOAD_SUCCESS',
      'Đã hủy phiên upload',
      await this.chunks.cancel(id),
    );
  }
}
