import { AppRelease, Prisma } from '$/prisma/client';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gt } from 'semver';
import { BaseService } from '~/modules/base/base.service';
import { PrismaService } from '~/modules/prisma/prisma.service';
import {
  APP_RELEASE_ROOT,
  APP_RELEASE_STAGING,
  AppReleaseFiles,
} from './app-release-upload';
import { AppReleaseQueryDTO } from './dto/app-release-query.dto';
import { prepareManifest } from './release-manifest';

@Injectable()
export class AppReleasesService extends BaseService<
  AppRelease,
  AppReleaseQueryDTO,
  never,
  never
> {
  private readonly logger = new Logger(AppReleasesService.name);

  constructor(private readonly prisma: PrismaService) {
    super(prisma.appRelease);
  }

  protected override buildWhere(
    query: AppReleaseQueryDTO,
  ): Prisma.AppReleaseWhereInput {
    return {
      ...(query.q
        ? { version: { contains: query.q, mode: 'insensitive' as const } }
        : {}),
      ...(query.status === 'draft' ? { publishedAt: null } : {}),
      ...(query.status === 'published' ? { publishedAt: { not: null } } : {}),
    };
  }

  async findPage(query: AppReleaseQueryDTO) {
    if (
      !['id', 'version', 'createdAt', 'publishedAt'].includes(
        query.sortBy ?? 'createdAt',
      )
    ) {
      throw new BadRequestException('sortBy không hợp lệ');
    }
    const result = await super.findAll(query);
    const channel = await this.prisma.appReleaseChannel.findUnique({
      where: { name: 'stable' },
    });
    return {
      ...result,
      data: result.data.map((release) =>
        this.toResponse(release, channel?.releaseId),
      ),
    };
  }

  override async findById(id: number) {
    const release = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!release) throw new NotFoundException('Không tìm thấy phiên bản');
    return release;
  }

  async detail(id: number) {
    const [release, channel] = await Promise.all([
      this.findById(id),
      this.prisma.appReleaseChannel.findUnique({ where: { name: 'stable' } }),
    ]);
    return this.toResponse(release, channel?.releaseId);
  }

  async upload(files: AppReleaseFiles | undefined, uploadedById: number) {
    const uploaded = Object.values(files ?? {}).flat();
    let ownedDirectory: string | undefined;
    try {
      const manifestFile = files?.manifest?.[0];
      const installer = files?.installer?.[0];
      const blockmap = files?.blockmap?.[0];
      if (!manifestFile || !installer || !blockmap || uploaded.length !== 3) {
        throw new BadRequestException(
          'Cần đủ 3 file: manifest, installer và blockmap',
        );
      }
      if (blockmap.originalname !== `${installer.originalname}.blockmap`) {
        throw new BadRequestException(
          'Tên file blockmap phải bằng tên bộ cài + .blockmap',
        );
      }
      if (
        manifestFile.size > 1024 * 1024 ||
        !installer.size ||
        !blockmap.size
      ) {
        throw new BadRequestException(
          'latest.yml tối đa 1 MB; bộ cài và blockmap không được rỗng',
        );
      }
      const [content, installerSha512, blockmapSha512] = await Promise.all([
        readFile(manifestFile.path, 'utf8'),
        this.hashFile(installer.path),
        this.hashFile(blockmap.path),
      ]);
      const prepared = prepareManifest(
        content,
        installer.originalname,
        installer.size,
        installerSha512,
        blockmap.size,
      );
      await mkdir(APP_RELEASE_ROOT, { recursive: true });
      const release = await this.mutate(async (tx) => {
        if (
          await tx.appRelease.findUnique({
            where: { version: prepared.version },
          })
        ) {
          throw new ConflictException('Version đã tồn tại');
        }
        const directory = join(APP_RELEASE_ROOT, prepared.version);
        // Exclusive mkdir never overwrites a directory left by another upload or recovery.
        try {
          await mkdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new ConflictException(
              'Thư mục version đã tồn tại; cần kiểm tra dữ liệu trên ổ đĩa',
            );
          }
          throw error;
        }
        ownedDirectory = directory;
        for (const file of uploaded)
          await rename(file.path, join(directory, file.originalname));
        return tx.appRelease.create({
          data: {
            version: prepared.version,
            manifest: prepared.manifest,
            installerName: installer.originalname,
            installerSize: installer.size,
            installerSha512,
            blockmapSize: blockmap.size,
            blockmapSha512,
          },
        });
      });
      ownedDirectory = undefined;
      return this.toResponse(release);
    } finally {
      await Promise.all(uploaded.map((file) => this.cleanup(file.path)));
      if (ownedDirectory) await this.cleanup(ownedDirectory);
    }
  }

  async publish(id: number, publishedById: number) {
    const candidate = await this.findById(id);
    // Read large artifacts before opening the transaction; mutations recheck the ID under lock.
    await this.verifyFiles(candidate);
    const release = await this.mutate(async (tx) => {
      const release = await tx.appRelease.findUnique({ where: { id } });
      if (!release) throw new NotFoundException('Không tìm thấy phiên bản');
      const channel = await tx.appReleaseChannel.findUnique({
        where: { name: 'stable' },
        include: { release: true },
      });
      if (channel?.releaseId === id) return release;
      if (channel && !gt(release.version, channel.release.version)) {
        throw new ConflictException(
          'Chỉ phát hành version lớn hơn phiên bản stable hiện tại',
        );
      }
      const published = await tx.appRelease.update({
        where: { id },
        data: {
          publishedAt: new Date(),
        },
      });
      await tx.appReleaseChannel.upsert({
        where: { name: 'stable' },
        create: { name: 'stable', releaseId: id },
        update: { releaseId: id },
      });
      return published;
    });
    return this.toResponse(release, release.id);
  }

  async deleteDraft(id: number) {
    let original: string | undefined;
    let trash: string | undefined;
    try {
      const deleted = await this.mutate(async (tx) => {
        const release = await tx.appRelease.findUnique({ where: { id } });
        if (!release) throw new NotFoundException('Không tìm thấy phiên bản');
        if (release.publishedAt)
          throw new ConflictException('Không được xóa phiên bản đã phát hành');
        await mkdir(APP_RELEASE_STAGING, { recursive: true });
        const source = join(APP_RELEASE_ROOT, release.version);
        const target = join(APP_RELEASE_STAGING, randomUUID());
        try {
          await rename(source, target);
          original = source;
          trash = target;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return tx.appRelease.delete({ where: { id } });
      });
      original = undefined;
      if (trash) await this.cleanup(trash);
      return this.toResponse(deleted);
    } catch (error) {
      if (original && trash) await rename(trash, original);
      throw error;
    }
  }

  async latestDetail() {
    const channel = await this.prisma.appReleaseChannel.findUnique({
      where: { name: 'stable' },
      include: { release: true },
    });
    if (!channel?.release.publishedAt)
      throw new NotFoundException('Chưa có phiên bản được phát hành');
    return this.toResponse(channel.release, channel.releaseId);
  }

  async latestManifest() {
    const channel = await this.prisma.appReleaseChannel.findUnique({
      where: { name: 'stable' },
      include: { release: true },
    });
    if (!channel?.release.publishedAt)
      throw new NotFoundException('Chưa có phiên bản được phát hành');
    return channel.release.manifest;
  }

  async publicFile(version: string, filename: string) {
    const release = await this.prisma.appRelease.findUnique({
      where: { version },
    });
    if (
      !release?.publishedAt ||
      ![
        release.installerName,
        `${release.installerName}.blockmap`,
        'latest.yml',
      ].includes(filename)
    ) {
      throw new NotFoundException('Không tìm thấy file phát hành');
    }
    return join(APP_RELEASE_ROOT, release.version, filename);
  }

  private toResponse(release: AppRelease, currentId?: number) {
    const { manifest: _manifest, ...data } = release;
    void _manifest;
    const base = `/uploads/app/release/${release.version}`;
    return {
      ...data,
      status: release.publishedAt ? 'published' : 'draft',
      isCurrent: release.id === currentId,
      files: {
        manifest: `${base}/latest.yml`,
        installer: `${base}/${encodeURIComponent(release.installerName)}`,
        blockmap: `${base}/${encodeURIComponent(release.installerName)}.blockmap`,
      },
    };
  }

  private async hashFile(path: string) {
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(path))
      hash.update(chunk as Buffer);
    return hash.digest('base64');
  }

  private async verifyFiles(release: AppRelease) {
    try {
      const directory = join(APP_RELEASE_ROOT, release.version);
      const installer = join(directory, release.installerName);
      const blockmap = `${installer}.blockmap`;
      const [
        installerStat,
        blockmapStat,
        installerHash,
        blockmapHash,
        manifest,
      ] = await Promise.all([
        stat(installer),
        stat(blockmap),
        this.hashFile(installer),
        this.hashFile(blockmap),
        readFile(join(directory, 'latest.yml'), 'utf8'),
      ]);
      if (
        installerStat.size !== release.installerSize ||
        blockmapStat.size !== release.blockmapSize ||
        installerHash !== release.installerSha512 ||
        blockmapHash !== release.blockmapSha512
      ) {
        throw new Error('checksum mismatch');
      }
      const prepared = prepareManifest(
        manifest,
        release.installerName,
        release.installerSize,
        installerHash,
        release.blockmapSize,
      );
      if (
        prepared.version !== release.version ||
        prepared.manifest !== release.manifest
      )
        throw new Error('manifest changed');
    } catch {
      throw new BadRequestException(
        'Bộ file trên ổ đĩa bị thiếu hoặc đã thay đổi; không thể phát hành',
      );
    }
  }

  private mutate<T>(
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        // Serialize publication, upload and deletion across all backend instances.
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(74102001)`;
        return action(tx);
      },
      { timeout: 30000 },
    );
  }

  private async cleanup(path: string) {
    const target = resolve(path);
    const allowed = [APP_RELEASE_ROOT, APP_RELEASE_STAGING].some((root) => {
      const child = relative(resolve(root), target);
      return (
        child !== '' &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child)
      );
    });
    if (!allowed) {
      this.logger.error(
        `Từ chối dọn file ngoài thư mục release/staging: ${target}`,
      );
      return;
    }
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      this.logger.error(`Không thể dọn file tạm: ${path}`, error);
    }
  }
}
