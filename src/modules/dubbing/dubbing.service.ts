import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DubbingCacheService } from './dubbing-cache.service';
import { DubbingSigningService } from './dubbing-signing.service';
import {
  DubbingWorkerClient,
  SubtitleDownloadFailedException,
} from './dubbing-worker.client';
import type {
  DubbingCue,
  DubbingHealthResponse,
  DubbingSegment,
  DubbingSessionTelemetry,
  SegmentsRequest,
  SegmentsResponse,
  SessionsResponse,
  TtsAudioResult,
  TtsRequest,
  UnsignedDubbingSegment,
  YoutubeSubtitlesRequest,
  YoutubeSubtitlesResponse,
} from './dubbing.types';
import {
  alignSourceText,
  cleanSubtitleText,
  DEFAULT_SEGMENT_DURATION_SECONDS,
  extractSoundsAndCleanCues,
  mergeCues,
  normalizeTtsRate,
  parseSubtitlePayload,
  partitionIntoSegments,
  selectSegmentForRequest,
} from './subtitle-parser';

const MAX_TELEMETRY_BATCH = 20;
const CONTEXT_CUE_WINDOW = 3;

interface CachedTranslatedSegment {
  index: number;
  start: number;
  end: number;
  cues: Array<{
    start: number;
    duration: number;
    text: string;
    sourceText?: string;
  }>;
  sounds: Array<{
    start: number;
    duration: number;
    text: string;
  }>;
}

interface CachedTtsPayload {
  audioBase64: string;
  duration: number;
  voice: string;
  rate: string;
}

@Injectable()
export class DubbingService {
  private readonly segmentInFlight = new Map<
    string,
    Promise<CachedTranslatedSegment>
  >();
  private readonly ttsInFlight = new Map<string, Promise<TtsAudioResult>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly signingService: DubbingSigningService,
    private readonly cacheService: DubbingCacheService,
    private readonly workerClient: DubbingWorkerClient,
  ) {}

  private get segmentCacheTtlSec(): number {
    return (
      this.configService.get<number>('DUBBING_SEGMENT_CACHE_TTL_SEC') || 86400
    );
  }

  private get ttsCacheTtlSec(): number {
    return this.configService.get<number>('DUBBING_TTS_CACHE_TTL_SEC') || 86400;
  }

  async health(): Promise<DubbingHealthResponse> {
    const worker = await this.workerClient.checkHealth();
    return {
      status: 'ok',
      protocol: 'tai-dubbing-v2',
      worker,
    };
  }

  async processYoutubeSubtitles(
    body: YoutubeSubtitlesRequest,
  ): Promise<YoutubeSubtitlesResponse> {
    const videoId = typeof body?.videoId === 'string' ? body.videoId.trim() : '';
    const targetLang =
      typeof body?.targetLang === 'string' ? body.targetLang.trim() : '';
    const subtitleText =
      typeof body?.subtitleText === 'string' ? body.subtitleText : '';
    const sourceText =
      typeof body?.sourceText === 'string' ? body.sourceText : undefined;

    if (!videoId || !targetLang || !subtitleText.trim()) {
      throw new BadRequestException({
        code: 'INVALID_SUBTITLE_REQUEST',
        message: 'videoId, targetLang, and subtitleText are required',
      });
    }

    const rawTarget = parseSubtitlePayload(subtitleText);
    const { cues: cleanedTarget, sounds } =
      extractSoundsAndCleanCues(rawTarget);
    let mergedTarget = mergeCues(cleanedTarget);

    if (sourceText && sourceText.trim()) {
      const rawSource = parseSubtitlePayload(sourceText);
      const { cues: cleanedSource } = extractSoundsAndCleanCues(rawSource);
      const mergedSource = mergeCues(cleanedSource);
      mergedTarget = alignSourceText(mergedTarget, mergedSource);
    }

    const rawSegments = partitionIntoSegments(
      mergedTarget,
      sounds,
      DEFAULT_SEGMENT_DURATION_SECONDS,
    );

    const segments: DubbingSegment[] = rawSegments.map((seg) =>
      this.signSegment(seg, targetLang),
    );

    // Best-effort cache for parsed YouTube segments
    const cacheKey = `dub:yt:${this.sha256(`${videoId}|${targetLang}|${subtitleText.length}`)}`;
    void this.cacheService.setJson(
      cacheKey,
      { videoId, targetLang, totalSegments: segments.length },
      this.segmentCacheTtlSec,
    );

    return {
      videoId,
      targetLang,
      translationSource: 'youtube',
      totalSegments: segments.length,
      segments,
    };
  }

  async getSegment(body: SegmentsRequest): Promise<SegmentsResponse> {
    const targetLang =
      typeof body?.targetLang === 'string' ? body.targetLang.trim() : '';
    const sourceLang =
      typeof body?.sourceLang === 'string' && body.sourceLang.trim()
        ? body.sourceLang.trim()
        : undefined;
    const subtitleUrl =
      typeof body?.subtitleUrl === 'string' && body.subtitleUrl.trim()
        ? body.subtitleUrl.trim()
        : undefined;
    const subtitleText =
      typeof body?.subtitleText === 'string' && body.subtitleText.trim()
        ? body.subtitleText
        : undefined;

    if (!targetLang) {
      throw new BadRequestException({
        code: 'INVALID_SEGMENT_REQUEST',
        message: 'targetLang is required',
      });
    }

    if (!subtitleUrl && !subtitleText) {
      throw new BadRequestException({
        code: 'INVALID_SEGMENT_REQUEST',
        message: 'Either subtitleUrl or subtitleText is required',
      });
    }

    if (
      body.segment !== undefined &&
      (!Number.isInteger(body.segment) || body.segment < 0)
    ) {
      throw new BadRequestException({
        code: 'INVALID_SEGMENT_INDEX',
        message: 'segment must be a non-negative integer',
      });
    }

    const videoId = this.resolveVideoId(body.videoId, subtitleUrl, subtitleText);
    const sourceSegments = await this.loadSourceSegments(
      videoId,
      sourceLang,
      subtitleUrl,
      subtitleText,
    );

    if (sourceSegments.length === 0) {
      return {
        videoId,
        targetLang,
        translationSource: 'ai',
        totalSegments: 0,
        segment: {
          index: 0,
          start: 0,
          end: 0,
          cues: [],
          sounds: [],
        },
      };
    }

    const selection = selectSegmentForRequest(sourceSegments, {
      currentTime: body.currentTime,
      segment: body.segment,
    });

    if (!selection) {
      throw new BadRequestException({
        code: 'SEGMENT_OUT_OF_RANGE',
        message: `Requested segment ${body.segment} is out of range (0..${sourceSegments.length - 1})`,
      });
    }

    const targetSourceSegment = selection.segment;
    const segHash = this.sha256(
      JSON.stringify({
        videoId,
        sourceLang: sourceLang ?? '',
        targetLang,
        index: targetSourceSegment.index,
        cues: targetSourceSegment.cues.map((c) => [c.start, c.duration, c.text]),
      }),
    );
    const cacheKey = `dub:seg:${segHash}`;

    const cached = await this.cacheService.getJson<CachedTranslatedSegment>(
      cacheKey,
    );

    let translated: CachedTranslatedSegment;
    if (cached) {
      translated = cached;
    } else {
      translated = await this.translateSegmentSingleFlight(
        cacheKey,
        sourceSegments,
        targetSourceSegment,
        targetLang,
        sourceLang,
      );
    }

    const signed = this.signSegment(translated, targetLang, selection.mappedFrom);

    return {
      videoId,
      targetLang,
      translationSource: 'ai',
      totalSegments: sourceSegments.length,
      segment: signed,
    };
  }

  async synthesizeTts(body: TtsRequest): Promise<TtsAudioResult> {
    const text = typeof body?.text === 'string' ? body.text : '';
    const lang = typeof body?.lang === 'string' ? body.lang.trim() : '';
    const sig = typeof body?.sig === 'string' ? body.sig : '';

    if (!text.trim() || !lang) {
      throw new BadRequestException({
        code: 'INVALID_TTS_REQUEST',
        message: 'text and lang are required',
      });
    }

    if (!this.signingService.verifyCueSignature(lang, text, sig)) {
      throw new ForbiddenException({
        code: 'INVALID_TTS_SIGNATURE',
        message: 'Invalid or missing TTS cue signature',
      });
    }

    const voice =
      typeof body.voice === 'string' && body.voice.trim()
        ? body.voice.trim()
        : undefined;
    const normalizedRate = normalizeTtsRate(body.rate);
    const cacheKey = `dub:tts:${this.sha256(`${lang}|${voice ?? ''}|${normalizedRate}|${text}`)}`;

    const cached = await this.cacheService.getJson<CachedTtsPayload>(cacheKey);
    if (cached?.audioBase64) {
      return {
        audio: Buffer.from(cached.audioBase64, 'base64'),
        duration: cached.duration ?? 0,
        voice: cached.voice ?? voice ?? '',
        rate: cached.rate ?? normalizedRate,
        cache: 'HIT',
      };
    }

    const existing = this.ttsInFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<TtsAudioResult> => {
      const result = await this.workerClient.synthesizeTts({
        text,
        lang,
        voice,
        rate: normalizedRate,
      });

      const payload: CachedTtsPayload = {
        audioBase64: result.audio.toString('base64'),
        duration: result.duration,
        voice: result.voice,
        rate: result.rate,
      };
      await this.cacheService.setJson(cacheKey, payload, this.ttsCacheTtlSec);

      return {
        ...result,
        cache: 'MISS',
      };
    })();

    this.ttsInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.ttsInFlight.delete(cacheKey);
    }
  }

  async ingestSessions(sessions: unknown): Promise<SessionsResponse> {
    if (!Array.isArray(sessions)) {
      throw new BadRequestException({
        code: 'INVALID_SESSIONS_PAYLOAD',
        message: 'sessions must be an array',
      });
    }

    if (sessions.length > MAX_TELEMETRY_BATCH) {
      throw new BadRequestException({
        code: 'TELEMETRY_BATCH_TOO_LARGE',
        message: `At most ${MAX_TELEMETRY_BATCH} sessions may be submitted per request`,
      });
    }

    const valid: DubbingSessionTelemetry[] = [];
    for (const item of sessions) {
      if (!item || typeof item !== 'object') {
        throw new BadRequestException({
          code: 'INVALID_SESSION_ITEM',
          message: 'Each session item must be an object',
        });
      }
      const rec = item as Record<string, unknown>;
      const videoId =
        typeof rec.videoId === 'string' ? rec.videoId.trim() : '';
      const targetLang =
        typeof rec.targetLang === 'string' ? rec.targetLang.trim() : '';
      const watchedSeconds = Number(rec.watchedSeconds);

      if (
        !videoId ||
        !targetLang ||
        !Number.isFinite(watchedSeconds) ||
        watchedSeconds < 0
      ) {
        throw new BadRequestException({
          code: 'INVALID_SESSION_ITEM',
          message:
            'Each session requires videoId, targetLang, and non-negative watchedSeconds',
        });
      }

      valid.push({
        ...(typeof rec.sessionId === 'string' ? { sessionId: rec.sessionId } : {}),
        videoId,
        ...(typeof rec.sourceLang === 'string'
          ? { sourceLang: rec.sourceLang }
          : {}),
        targetLang,
        ...(typeof rec.translationSource === 'string'
          ? { translationSource: rec.translationSource }
          : {}),
        watchedSeconds,
        ...(typeof rec.dubbedCues === 'number'
          ? { dubbedCues: rec.dubbedCues }
          : {}),
        ...(typeof rec.truncatedCues === 'number'
          ? { truncatedCues: rec.truncatedCues }
          : {}),
        ...(typeof rec.gateForced === 'number'
          ? { gateForced: rec.gateForced }
          : {}),
        ...(typeof rec.fallbackCues === 'number'
          ? { fallbackCues: rec.fallbackCues }
          : {}),
        ...(typeof rec.startedAt === 'number' ? { startedAt: rec.startedAt } : {}),
        ...(typeof rec.endedAt === 'number' ? { endedAt: rec.endedAt } : {}),
      });
    }

    await this.cacheService.recordSessions(valid);
    return { accepted: valid.length };
  }

  private async loadSourceSegments(
    videoId: string,
    sourceLang: string | undefined,
    subtitleUrl: string | undefined,
    subtitleText: string | undefined,
  ): Promise<UnsignedDubbingSegment[]> {
    const trackKey = this.stableTrackKey(subtitleUrl);
    const sourceCacheKey = `dub:src:${this.sha256(`${videoId}|${sourceLang ?? ''}|${trackKey}`)}`;

    if (!subtitleText && subtitleUrl) {
      const cachedSource =
        await this.cacheService.getJson<UnsignedDubbingSegment[]>(
          sourceCacheKey,
        );
      if (cachedSource && Array.isArray(cachedSource) && cachedSource.length > 0) {
        return cachedSource;
      }
    }

    let rawText = subtitleText;
    if (!rawText && subtitleUrl) {
      rawText = await this.workerClient.downloadSubtitleUrl(subtitleUrl);
    }

    const rawCues = parseSubtitlePayload(rawText ?? '');
    if (rawCues.length === 0 && subtitleUrl && !subtitleText) {
      throw new SubtitleDownloadFailedException(
        'Downloaded subtitle content could not be parsed',
      );
    }

    const { cues, sounds } = extractSoundsAndCleanCues(rawCues);
    const merged = mergeCues(cues);
    const segments = partitionIntoSegments(
      merged,
      sounds,
      DEFAULT_SEGMENT_DURATION_SECONDS,
    );

    if (segments.length > 0) {
      await this.cacheService.setJson(
        sourceCacheKey,
        segments,
        this.segmentCacheTtlSec,
      );
    }

    return segments;
  }

  private async translateSegmentSingleFlight(
    cacheKey: string,
    allSourceSegments: UnsignedDubbingSegment[],
    sourceSegment: UnsignedDubbingSegment,
    targetLang: string,
    sourceLang?: string,
  ): Promise<CachedTranslatedSegment> {
    const existing = this.segmentInFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<CachedTranslatedSegment> => {
      if (sourceSegment.cues.length === 0) {
        return {
          index: sourceSegment.index,
          start: sourceSegment.start,
          end: sourceSegment.end,
          cues: [],
          sounds: sourceSegment.sounds,
        };
      }

      const prevSeg = allSourceSegments[sourceSegment.index - 1];
      const nextSeg = allSourceSegments[sourceSegment.index + 1];
      const context_prev = prevSeg
        ? prevSeg.cues.slice(-CONTEXT_CUE_WINDOW).map((c) => c.text)
        : undefined;
      const context_next = nextSeg
        ? nextSeg.cues.slice(0, CONTEXT_CUE_WINDOW).map((c) => c.text)
        : undefined;

      const workerResp = await this.workerClient.translateSegment({
        cues: sourceSegment.cues.map(({ start, duration, text }) => ({
          start,
          duration,
          text,
        })),
        target_lang: targetLang,
        ...(sourceLang ? { source_lang: sourceLang } : {}),
        ...(context_prev?.length ? { context_prev } : {}),
        ...(context_next?.length ? { context_next } : {}),
      });

      const translatedCues = (workerResp.cues ?? [])
        .map((cue, idx) => ({
          start: cue.start ?? sourceSegment.cues[idx]?.start ?? 0,
          duration: cue.duration ?? sourceSegment.cues[idx]?.duration ?? 1,
          text: cleanSubtitleText(cue.text ?? ''),
          sourceText: cue.sourceText ?? sourceSegment.cues[idx]?.text,
        }))
        .filter((cue) => cue.text.length > 0);

      const translated: CachedTranslatedSegment = {
        index: sourceSegment.index,
        start: sourceSegment.start,
        end: sourceSegment.end,
        cues: translatedCues,
        sounds: sourceSegment.sounds,
      };

      await this.cacheService.setJson(
        cacheKey,
        translated,
        this.segmentCacheTtlSec,
      );

      return translated;
    })();

    this.segmentInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.segmentInFlight.delete(cacheKey);
    }
  }

  private signSegment(
    segment: CachedTranslatedSegment | UnsignedDubbingSegment,
    targetLang: string,
    mappedFrom?: number,
  ): DubbingSegment {
    const cues: DubbingCue[] = segment.cues.map((cue) => ({
      start: cue.start,
      duration: cue.duration,
      text: cue.text,
      ...(cue.sourceText !== undefined ? { sourceText: cue.sourceText } : {}),
      sig: this.signingService.signCue(targetLang, cue.text),
    }));

    return {
      index: segment.index,
      start: segment.start,
      end: segment.end,
      ...(mappedFrom !== undefined ? { mappedFrom } : {}),
      cues,
      sounds: segment.sounds,
    };
  }

  private resolveVideoId(
    explicitVideoId?: string,
    subtitleUrl?: string,
    subtitleText?: string,
  ): string {
    if (explicitVideoId && explicitVideoId.trim()) {
      return explicitVideoId.trim();
    }
    if (subtitleUrl) {
      try {
        const parsed = new URL(subtitleUrl);
        const v = parsed.searchParams.get('v');
        if (v && v.trim()) {
          return v.trim();
        }
      } catch {
        // Fallback to hash below
      }
    }
    return this.sha256(subtitleUrl || subtitleText || 'unknown').slice(0, 16);
  }

  private stableTrackKey(subtitleUrl?: string): string {
    if (!subtitleUrl) return '';
    try {
      const parsed = new URL(subtitleUrl);
      const volatileParams = new Set([
        'pot',
        'potc',
        'expire',
        'signature',
        'sig',
        'xorb',
        'xobt',
        'xovt',
        'cbr',
        'c',
        'cver',
      ]);
      const kept: string[] = [];
      for (const [k, v] of [...parsed.searchParams.entries()].sort()) {
        if (!volatileParams.has(k.toLowerCase())) {
          kept.push(`${k}=${v}`);
        }
      }
      return `${parsed.origin}${parsed.pathname}?${kept.join('&')}`;
    } catch {
      return '';
    }
  }

  private sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }
}
