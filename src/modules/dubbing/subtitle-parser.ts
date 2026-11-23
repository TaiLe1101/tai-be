import type {
  DubbingSound,
  UnsignedDubbingCue,
  UnsignedDubbingSegment,
} from './dubbing.types';

export const DEFAULT_SEGMENT_DURATION_SECONDS = 45;
const MERGE_MAX_GAP_SECONDS = 0.8;
const MERGE_MAX_DURATION_SECONDS = 8.0;
const MERGE_MAX_CHARS = 180;
const MERGE_MAX_CJK_CHARS = 90;
const MIN_CUE_DURATION_SECONDS = 0.25;

const LEADING_PAREN_RE = /^[-–—ー]?\s*[(（]([^()（）]{1,40})[)）]\s*/;
const TRAILING_PAREN_RE =
  /(^|[\s.!?,。！？，、])[(（]([^()（）]{1,40})[)）]\s*$/;
const BRACKET_RE = /\[([^\]]*)\]|【([^】]*)】/g;
const SENTENCE_END_RE = /[.!?。！？…]$/;
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export interface RawSubtitleCue {
  start: number;
  duration: number;
  text: string;
}

export interface CleanSubtitleResult {
  text: string;
  sounds: string[];
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function isRemovableParenthetical(inner: string): boolean {
  const trimmed = inner.trim();
  if (!trimmed) return true;
  if (/\d/.test(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount <= 4;
}

/**
 * Cleans subtitle text following AutoDub's exact rules:
 * - Strips [...] and 【...】 globally (capturing inner labels as non-speech sounds)
 * - Iteratively strips leading and trailing parentheticals up to 40 chars
 *   ONLY when inner text contains no digits and <= 4 words.
 */
export function cleanSubtitleTextWithSounds(
  rawText: string,
): CleanSubtitleResult {
  const sounds: string[] = [];
  let text = decodeHtmlEntities(rawText).replace(/[\r\n\t]+/g, ' ');

  text = text.replace(BRACKET_RE, (_, sq?: string, jp?: string) => {
    const label = (sq ?? jp ?? '').trim();
    if (label) sounds.push(label);
    return ' ';
  });

  text = text.replace(/\s+/g, ' ').trim();

  while (text.length > 0) {
    const match = LEADING_PAREN_RE.exec(text);
    if (!match || !isRemovableParenthetical(match[1])) {
      break;
    }
    const label = match[1].trim();
    if (label) sounds.push(label);
    text = text.slice(match[0].length).trim();
  }

  while (text.length > 0) {
    const match = TRAILING_PAREN_RE.exec(text);
    if (!match || !isRemovableParenthetical(match[2])) {
      break;
    }
    const label = match[2].trim();
    if (label) sounds.push(label);
    const keepPrefix = match[1] ?? '';
    text = (text.slice(0, match.index) + keepPrefix).trim();
  }

  text = text.replace(/\s+/g, ' ').trim();
  return { text, sounds };
}

export function cleanSubtitleText(rawText: string): string {
  return cleanSubtitleTextWithSounds(rawText).text;
}

function parseJson3(parsed: Record<string, unknown>): RawSubtitleCue[] {
  const events = parsed.events;
  if (!Array.isArray(events)) return [];

  const raw: Array<{ start: number; duration?: number; text: string }> = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const record = ev as Record<string, unknown>;
    const segs = record.segs;
    if (!Array.isArray(segs) || segs.length === 0) continue;

    const text = segs
      .map((seg) =>
        seg && typeof seg === 'object' && typeof (seg as { utf8?: unknown }).utf8 === 'string'
          ? (seg as { utf8: string }).utf8
          : '',
      )
      .join('')
      .replace(/[\r\n]+/g, ' ')
      .trim();

    if (!text) continue;

    const startMs =
      typeof record.tStartMs === 'number' && Number.isFinite(record.tStartMs)
        ? Math.max(0, record.tStartMs)
        : 0;
    const durationMs =
      typeof record.dDurationMs === 'number' &&
      Number.isFinite(record.dDurationMs) &&
      record.dDurationMs > 0
        ? record.dDurationMs
        : undefined;

    raw.push({
      start: startMs / 1000,
      duration: durationMs !== undefined ? durationMs / 1000 : undefined,
      text,
    });
  }

  raw.sort((a, b) => a.start - b.start);

  return raw.map((item, idx) => {
    let duration = item.duration;
    if (duration === undefined) {
      const next = raw[idx + 1];
      duration = next
        ? Math.min(5, Math.max(0.5, next.start - item.start))
        : 2.0;
    }
    return {
      start: roundTime(item.start),
      duration: roundTime(Math.max(MIN_CUE_DURATION_SECONDS, duration)),
      text: item.text,
    };
  });
}

function parseCueArray(items: unknown[]): RawSubtitleCue[] {
  const cues: RawSubtitleCue[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    const start = typeof rec.start === 'number' ? rec.start : Number(rec.start);
    if (!text || !Number.isFinite(start)) continue;

    let duration: number;
    if (typeof rec.duration === 'number' && Number.isFinite(rec.duration)) {
      duration = rec.duration;
    } else if (typeof rec.end === 'number' && Number.isFinite(rec.end)) {
      duration = rec.end - start;
    } else {
      duration = 2.0;
    }

    cues.push({
      start: roundTime(Math.max(0, start)),
      duration: roundTime(Math.max(MIN_CUE_DURATION_SECONDS, duration)),
      text,
    });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function extractXmlAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  return re.exec(attrs)?.[1];
}

function parseXmlSubtitles(rawText: string): RawSubtitleCue[] {
  const cues: RawSubtitleCue[] = [];

  // Format 1: <transcript><text start="1.23" dur="2.34">...</text></transcript>
  const textTagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = textTagRe.exec(rawText)) !== null) {
    const attrs = match[1];
    const startVal = Number.parseFloat(extractXmlAttr(attrs, 'start') ?? '');
    const durVal = Number.parseFloat(extractXmlAttr(attrs, 'dur') ?? '');
    if (!Number.isFinite(startVal)) continue;

    const inner = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' '))
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    if (!inner) continue;

    cues.push({
      start: roundTime(Math.max(0, startVal)),
      duration: roundTime(
        Number.isFinite(durVal) && durVal > 0
          ? Math.max(MIN_CUE_DURATION_SECONDS, durVal)
          : 2.0,
      ),
      text: inner,
    });
  }

  if (cues.length > 0) {
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  // Format 2: <timedtext format="3"><body><p t="1230" d="2340"><s>...</s></p></body></timedtext>
  const pTagRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  while ((match = pTagRe.exec(rawText)) !== null) {
    const attrs = match[1];
    const tMs = Number.parseFloat(extractXmlAttr(attrs, 't') ?? '');
    const dMs = Number.parseFloat(extractXmlAttr(attrs, 'd') ?? '');
    if (!Number.isFinite(tMs)) continue;

    const inner = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ''))
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    if (!inner) continue;

    cues.push({
      start: roundTime(Math.max(0, tMs / 1000)),
      duration: roundTime(
        Number.isFinite(dMs) && dMs > 0
          ? Math.max(MIN_CUE_DURATION_SECONDS, dMs / 1000)
          : 2.0,
      ),
      text: inner,
    });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

export function parseSubtitlePayload(rawText: string): RawSubtitleCue[] {
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parseCueArray(parsed);
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.events)) {
          return parseJson3(obj);
        }
        if (Array.isArray(obj.cues)) {
          return parseCueArray(obj.cues);
        }
      }
    } catch {
      // Fall through to XML parsing if text wasn't valid JSON
    }
  }

  if (trimmed.includes('<text') || trimmed.includes('<p')) {
    return parseXmlSubtitles(trimmed);
  }

  return [];
}

export function dedupeAndSortSounds(sounds: DubbingSound[]): DubbingSound[] {
  const seen = new Set<string>();
  const unique: DubbingSound[] = [];
  for (const sound of sounds) {
    const text = sound.text.trim();
    if (!text) continue;
    const start = roundTime(Math.max(0, sound.start));
    const duration = roundTime(
      Math.max(MIN_CUE_DURATION_SECONDS, sound.duration),
    );
    const key = `${start}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ start, duration, text });
  }
  unique.sort((a, b) => a.start - b.start || a.text.localeCompare(b.text));
  return unique;
}

export function extractSoundsAndCleanCues(rawCues: RawSubtitleCue[]): {
  cues: UnsignedDubbingCue[];
  sounds: DubbingSound[];
} {
  const cues: UnsignedDubbingCue[] = [];
  const sounds: DubbingSound[] = [];

  for (const raw of rawCues) {
    const cleaned = cleanSubtitleTextWithSounds(raw.text);
    for (const label of cleaned.sounds) {
      sounds.push({
        start: roundTime(raw.start),
        duration: roundTime(Math.max(MIN_CUE_DURATION_SECONDS, raw.duration)),
        text: label,
      });
    }
    if (cleaned.text) {
      cues.push({
        start: roundTime(raw.start),
        duration: roundTime(Math.max(MIN_CUE_DURATION_SECONDS, raw.duration)),
        text: cleaned.text,
      });
    }
  }

  return {
    cues,
    sounds: dedupeAndSortSounds(sounds),
  };
}

function joinCueTexts(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  const lastChar = left[left.length - 1];
  const firstChar = right[0];
  if (CJK_CHAR_RE.test(lastChar) && CJK_CHAR_RE.test(firstChar)) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

export function mergeCues(cues: UnsignedDubbingCue[]): UnsignedDubbingCue[] {
  if (cues.length <= 1) {
    return cues.map((cue) => ({ ...cue }));
  }

  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const merged: UnsignedDubbingCue[] = [];

  for (const current of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...current });
      continue;
    }

    const prevEnd = prev.start + prev.duration;
    const currEnd = current.start + current.duration;
    const gap = current.start - prevEnd;
    const combinedSpan = Math.max(prevEnd, currEnd) - prev.start;
    const combinedText = joinCueTexts(prev.text, current.text);
    const maxChars = CJK_CHAR_RE.test(combinedText)
      ? MERGE_MAX_CJK_CHARS
      : MERGE_MAX_CHARS;

    const shouldMerge =
      gap <= MERGE_MAX_GAP_SECONDS &&
      !SENTENCE_END_RE.test(prev.text) &&
      combinedSpan <= MERGE_MAX_DURATION_SECONDS &&
      combinedText.length <= maxChars;

    if (shouldMerge) {
      prev.text = combinedText;
      prev.duration = roundTime(
        Math.max(MIN_CUE_DURATION_SECONDS, Math.max(prevEnd, currEnd) - prev.start),
      );
      if (prev.sourceText && current.sourceText) {
        prev.sourceText = joinCueTexts(prev.sourceText, current.sourceText);
      } else if (current.sourceText) {
        prev.sourceText = current.sourceText;
      }
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

export function alignSourceText(
  targetCues: UnsignedDubbingCue[],
  sourceCues: UnsignedDubbingCue[],
): UnsignedDubbingCue[] {
  if (sourceCues.length === 0) {
    return targetCues;
  }

  return targetCues.map((target) => {
    const tStart = target.start;
    const tEnd = target.start + target.duration;
    const matchedByMidpoint: UnsignedDubbingCue[] = [];
    let bestOverlapCue: UnsignedDubbingCue | undefined;
    let bestOverlap = 0;

    for (const src of sourceCues) {
      const sStart = src.start;
      const sEnd = src.start + src.duration;
      if (sEnd <= tStart - 0.15) continue;
      if (sStart >= tEnd + 0.15) break;

      const sMid = (sStart + sEnd) / 2;
      if (sMid >= tStart - 0.15 && sMid <= tEnd + 0.15) {
        matchedByMidpoint.push(src);
      }

      const overlap = Math.min(tEnd, sEnd) - Math.max(tStart, sStart);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestOverlapCue = src;
      }
    }

    const matched =
      matchedByMidpoint.length > 0
        ? matchedByMidpoint
        : bestOverlapCue
          ? [bestOverlapCue]
          : [];

    if (matched.length === 0) {
      return { ...target };
    }

    const sourceText = matched.reduce(
      (acc, item) => joinCueTexts(acc, item.text),
      '',
    );
    return {
      ...target,
      sourceText,
    };
  });
}

export function partitionIntoSegments(
  cues: UnsignedDubbingCue[],
  sounds: DubbingSound[],
  segmentDurationSec = DEFAULT_SEGMENT_DURATION_SECONDS,
): UnsignedDubbingSegment[] {
  const sortedCues = [...cues].sort((a, b) => a.start - b.start);
  const sortedSounds = dedupeAndSortSounds(sounds);

  if (sortedCues.length === 0) {
    if (sortedSounds.length === 0) {
      return [];
    }
    const start = sortedSounds[0].start;
    const end = Math.max(
      ...sortedSounds.map((s) => roundTime(s.start + s.duration)),
    );
    return [
      {
        index: 0,
        start,
        end,
        cues: [],
        sounds: sortedSounds,
      },
    ];
  }

  const segments: UnsignedDubbingSegment[] = [];
  let bucket: UnsignedDubbingCue[] = [];
  let bucketStart = sortedCues[0].start;
  let bucketEnd = sortedCues[0].start + sortedCues[0].duration;

  const flush = () => {
    if (bucket.length === 0) return;
    segments.push({
      index: segments.length,
      start: roundTime(bucketStart),
      end: roundTime(bucketEnd),
      cues: bucket,
      sounds: [],
    });
    bucket = [];
  };

  for (const cue of sortedCues) {
    const cueEnd = cue.start + cue.duration;
    if (
      bucket.length > 0 &&
      cueEnd - bucketStart > segmentDurationSec
    ) {
      flush();
      bucketStart = cue.start;
      bucketEnd = cueEnd;
    } else if (bucket.length === 0) {
      bucketStart = cue.start;
      bucketEnd = cueEnd;
    } else {
      bucketEnd = Math.max(bucketEnd, cueEnd);
    }
    bucket.push(cue);
  }
  flush();

  for (const sound of sortedSounds) {
    let target = segments.find((seg) => sound.start <= seg.end);
    if (!target) {
      target = segments[segments.length - 1];
    }
    target.sounds.push(sound);
  }

  for (const seg of segments) {
    seg.sounds = dedupeAndSortSounds(seg.sounds);
  }

  return segments;
}

/**
 * Selects target segment matching AutoDub's `segmentAt` semantics:
 * - Explicit `segment` index takes precedence when provided.
 * - Otherwise picks the segment with smallest `end >= t` (or last segment if past end).
 * - Sets `mappedFrom` when `t < chosen.start` (seek landed in a silence gap before the segment).
 */
export function selectSegmentForRequest<
  T extends { index: number; start: number; end: number },
>(
  segments: T[],
  options: { currentTime?: number; segment?: number },
): { segment: T; mappedFrom?: number } | null {
  if (segments.length === 0) {
    return null;
  }

  if (options.segment !== undefined) {
    const idx = options.segment;
    if (!Number.isInteger(idx) || idx < 0 || idx >= segments.length) {
      return null;
    }
    return { segment: segments[idx] };
  }

  const t = Math.max(0, Number.isFinite(options.currentTime) ? (options.currentTime as number) : 0);
  let chosen: T | undefined;
  for (const seg of segments) {
    if (seg.end >= t) {
      if (!chosen || seg.end < chosen.end) {
        chosen = seg;
      }
    }
  }
  if (!chosen) {
    chosen = segments[segments.length - 1];
  }

  const mappedFrom = t < chosen.start ? roundTime(t) : undefined;
  return { segment: chosen, mappedFrom };
}

export function normalizeTtsRate(rate?: string | number): string {
  if (rate === undefined || rate === null || rate === '') {
    return '+0%';
  }
  if (typeof rate === 'number' && Number.isFinite(rate)) {
    const clamped = Math.min(2.0, Math.max(0.5, Math.round(rate * 10) / 10));
    const pct = Math.round((clamped - 1) * 100);
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  }
  const str = String(rate).trim();
  const numeric = Number(str);
  if (Number.isFinite(numeric) && !str.endsWith('%')) {
    return normalizeTtsRate(numeric);
  }
  const pctMatch = /^([+-]?\d+(?:\.\d+)?)%$/.exec(str);
  if (pctMatch) {
    const pct = Math.round(
      Math.min(100, Math.max(-50, Number.parseFloat(pctMatch[1]))),
    );
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  }
  return '+0%';
}
