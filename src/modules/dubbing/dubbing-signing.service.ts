import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_DUBBING_SIGNING_SECRET = 'tai-dubbing-dev-signing-secret';

@Injectable()
export class DubbingSigningService {
  private readonly secret: string;

  constructor(private readonly configService: ConfigService) {
    this.secret =
      this.configService.get<string>('DUBBING_SIGNING_SECRET')?.trim() ||
      DEFAULT_DUBBING_SIGNING_SECRET;
  }

  signCue(lang: string, text: string): string {
    const payload = `v1|${lang}|${text}`;
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  verifyCueSignature(lang: string, text: string, sig: string): boolean {
    if (!sig || typeof sig !== 'string') {
      return false;
    }
    const expected = this.signCue(lang, text);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(sig.trim(), 'utf8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, providedBuf);
  }
}
