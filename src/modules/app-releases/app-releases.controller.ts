import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PERMISSIONS } from '~/common/constants/permissions.constant';
import { RequirePermission } from '~/common/decorators/permissions.decorator';
import { ResponseApi } from '~/types/response-api.type';
import { appReleaseMulterOptions } from './app-release-upload';
import type { AppReleaseFiles } from './app-release-upload';
import { AppReleasesService } from './app-releases.service';
import { AppReleaseQueryDTO } from './dto/app-release-query.dto';
import { Public } from '~/common/decorators/public.decorator';

@ApiTags('Phiên bản desktop app')
// @ApiBearerAuth('JWT-Auth')
@Controller('app-releases')
export class AppReleasesController {
  constructor(private readonly releases: AppReleasesService) {}

  @Public()
  @Get()
  // @RequirePermission(PERMISSIONS.APP_RELEASES.VIEW)
  @ApiOperation({ summary: 'Danh sách phiên bản desktop app' })
  async index(@Query() query: AppReleaseQueryDTO) {
    const { data, pagination, meta } = await this.releases.findPage(query);
    return new ResponseApi(
      HttpStatus.OK,
      'GET_APP_RELEASES_SUCCESS',
      'Lấy danh sách phiên bản thành công',
      data,
      pagination,
      meta,
    );
  }

  @Public()
  @Get('latest')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Chi tiết phiên bản stable đang phát hành cho landing page',
  })
  async latest() {
    return new ResponseApi(
      HttpStatus.OK,
      'GET_APP_RELEASE_SUCCESS',
      'Lấy phiên bản thành công',
      await this.releases.latestDetail(),
    );
  }

  @Public()
  @Get(':id')
  // @RequirePermission(PERMISSIONS.APP_RELEASES.VIEW)
  @ApiOperation({ summary: 'Chi tiết phiên bản desktop app' })
  async detail(@Param('id', ParseIntPipe) id: number) {
    return new ResponseApi(
      HttpStatus.OK,
      'GET_APP_RELEASE_SUCCESS',
      'Lấy phiên bản thành công',
      await this.releases.detail(id),
    );
  }

  @Public()
  @Post()
  // @RequirePermission(PERMISSIONS.APP_RELEASES.UPLOAD)
  @ApiOperation({
    summary: 'Upload đủ 3 file để tạo bản nháp; version lấy từ latest.yml',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['manifest', 'installer', 'blockmap'],
      properties: {
        manifest: {
          type: 'string',
          format: 'binary',
          description: 'latest.yml (tối đa 1 MB)',
        },
        installer: {
          type: 'string',
          format: 'binary',
          description: '*.exe (tối đa 500 MB)',
        },
        blockmap: {
          type: 'string',
          format: 'binary',
          description: '*.exe.blockmap (tối đa 500 MB)',
        },
      },
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'manifest', maxCount: 1 },
        { name: 'installer', maxCount: 1 },
        { name: 'blockmap', maxCount: 1 },
      ],
      appReleaseMulterOptions,
    ),
  )
  async upload(@UploadedFiles() files: AppReleaseFiles) {
    return new ResponseApi(
      HttpStatus.CREATED,
      'UPLOAD_APP_RELEASE_SUCCESS',
      'Tạo bản nháp thành công',
      await this.releases.upload(files),
    );
  }

  @Public()
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  // @RequirePermission(PERMISSIONS.APP_RELEASES.PUBLISH)
  @ApiOperation({ summary: 'Phát hành phiên bản lên kênh stable' })
  async publish(@Param('id', ParseIntPipe) id: number) {
    return new ResponseApi(
      HttpStatus.OK,
      'PUBLISH_APP_RELEASE_SUCCESS',
      'Phát hành phiên bản thành công',
      await this.releases.publish(id),
    );
  }

  @Public()
  @Delete(':id')
  // @RequirePermission(PERMISSIONS.APP_RELEASES.DELETE)
  @ApiOperation({
    summary: 'Xóa bản nháp; không cho phép xóa bản đã phát hành',
  })
  async delete(@Param('id', ParseIntPipe) id: number) {
    return new ResponseApi(
      HttpStatus.OK,
      'DELETE_APP_RELEASE_SUCCESS',
      'Xóa bản nháp thành công',
      await this.releases.deleteDraft(id),
    );
  }
}
