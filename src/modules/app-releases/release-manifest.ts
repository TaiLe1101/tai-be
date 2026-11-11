import { BadRequestException } from '@nestjs/common';
import { valid, prerelease } from 'semver';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';

const manifestSchema = z
  .object({
    version: z.string(),
    files: z
      .array(
        z
          .object({
            url: z.string(),
            sha512: z.string(),
            size: z.number().int().positive(),
            blockMapSize: z.number().int().nonnegative().optional(),
            blockMapUrl: z.string().optional(),
          })
          .passthrough(),
      )
      .length(1),
    path: z.string().optional(),
    sha512: z.string().optional(),
  })
  .passthrough();

export function prepareManifest(
  content: string,
  installerName: string,
  installerSize: number,
  installerSha512: string,
  blockmapSize: number,
) {
  try {
    const document = parseDocument(content, { uniqueKeys: true });
    if (document.errors.length) throw new Error('YAML không hợp lệ');
    const manifest = manifestSchema.parse(document.toJS({ maxAliasCount: 0 }));
    const version = manifest.version;
    if (
      valid(version) !== version ||
      prerelease(version) ||
      version.includes('+')
    ) {
      throw new Error('version phải là SemVer stable, ví dụ 1.2.3');
    }
    // These require other artifacts or re-signing, outside the three-file Windows feed.
    if (
      'packages' in manifest ||
      'signature' in manifest ||
      'signatures' in manifest
    ) {
      throw new Error(
        'Chỉ hỗ trợ manifest Windows một bộ cài, không có chữ ký manifest hoặc packages',
      );
    }
    const file = manifest.files[0];
    const matchesInstaller = (value: string) =>
      value === installerName ||
      value === encodeURIComponent(installerName) ||
      value === `${version}/${installerName}` ||
      value === `${version}/${encodeURIComponent(installerName)}`;
    if (
      !matchesInstaller(file.url) ||
      (manifest.path && !matchesInstaller(manifest.path))
    ) {
      throw new Error('Tên bộ cài trong latest.yml không khớp file .exe');
    }
    if (
      file.size !== installerSize ||
      file.sha512 !== installerSha512 ||
      (manifest.sha512 !== undefined && manifest.sha512 !== installerSha512)
    ) {
      throw new Error('size hoặc SHA-512 trong latest.yml không khớp bộ cài');
    }
    if (file.blockMapSize !== undefined && file.blockMapSize !== blockmapSize) {
      throw new Error('blockMapSize không khớp file .blockmap');
    }
    file.url = `${version}/${encodeURIComponent(installerName)}`;
    if (file.blockMapUrl !== undefined) {
      const expected = `${installerName}.blockmap`;
      if (
        ![
          expected,
          encodeURIComponent(expected),
          `${version}/${expected}`,
          `${version}/${encodeURIComponent(expected)}`,
        ].includes(file.blockMapUrl)
      ) {
        throw new Error('blockMapUrl không khớp file .blockmap');
      }
      file.blockMapUrl = `${file.url}.blockmap`;
    }
    if (manifest.path !== undefined) manifest.path = file.url;
    return { version, manifest: stringify(manifest) };
  } catch (error) {
    throw new BadRequestException(
      error instanceof Error
        ? `latest.yml: ${error.message}`
        : 'latest.yml không hợp lệ',
    );
  }
}
