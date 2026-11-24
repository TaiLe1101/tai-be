import type { QuotaDto } from '~/modules/saas/saas.types';

export interface DubbingSound {
  start: number;
  duration: number;
  text: string;
}

export interface DubbingCue {
  start: number;
  duration: number;
  text: string;
  sourceText?: string;
  sig: string;
}

export interface UnsignedDubbingCue {
  start: number;
  duration: number;
  text: string;
  sourceText?: string;
}

export interface DubbingSegment {
  index: number;
  start: number;
  end: number;
  mappedFrom?: number;
  cues: DubbingCue[];
  sounds: DubbingSound[];
}

export interface UnsignedDubbingSegment {
  index: number;
  start: number;
  end: number;
  cues: UnsignedDubbingCue[];
  sounds: DubbingSound[];
}

export interface YoutubeSubtitlesRequest {
  videoId: string;
  targetLang: string;
  sourceLang?: string;
  subtitleText: string;
  sourceText?: string;
}

export interface YoutubeSubtitlesResponse {
  videoId: string;
  targetLang: string;
  translationSource: 'youtube';
  totalSegments: number;
  segments: DubbingSegment[];
}

export interface SegmentsRequest {
  videoId?: string;
  subtitleUrl?: string;
  subtitleText?: string;
  targetLang: string;
  sourceLang?: string;
  currentTime?: number;
  segment?: number;
}

export interface SegmentsResponse {
  videoId: string;
  targetLang: string;
  translationSource: 'ai';
  totalSegments: number;
  segment: DubbingSegment;
}

export interface TtsRequest {
  text: string;
  lang: string;
  voice?: string;
  rate?: string | number;
  sig: string;
  inline?: boolean;
}

export interface TtsAudioResult {
  audio: Buffer;
  duration: number;
  voice: string;
  rate: string;
  cache: 'HIT' | 'MISS';
}

export interface TtsJsonResponse {
  audioBase64: string;
  contentType: 'audio/mpeg';
  duration: number;
  voice: string;
  rate: string;
}

export interface DubbingSessionTelemetry {
  sessionId?: string;
  videoId: string;
  sourceLang?: string;
  targetLang: string;
  translationSource?: string;
  watchedSeconds: number;
  dubbedCues?: number;
  truncatedCues?: number;
  gateForced?: number;
  fallbackCues?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface SessionsRequest {
  sessions: DubbingSessionTelemetry[];
}

export interface SessionsResponse {
  accepted: number;
  quota?: QuotaDto;
}

export interface WorkerHealthStatus {
  ok: boolean;
  protocol?: string;
  capabilities?: string[];
}

export interface DubbingHealthResponse {
  status: 'ok';
  protocol: 'tai-dubbing-v2';
  worker: WorkerHealthStatus;
}

export interface WorkerTranslateSegmentRequest {
  cues: Array<{ start: number; duration: number; text: string }>;
  target_lang: string;
  source_lang?: string;
  context_prev?: string[];
  context_next?: string[];
}

export interface WorkerTranslateSegmentResponse {
  target_lang: string;
  engine: 'gemini' | 'google' | 'cache';
  cues: Array<{
    start: number;
    duration: number;
    text: string;
    sourceText: string;
  }>;
}
