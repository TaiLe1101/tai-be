import {
  alignSourceText,
  cleanSubtitleText,
  cleanSubtitleTextWithSounds,
  dedupeAndSortSounds,
  extractSoundsAndCleanCues,
  mergeCues,
  normalizeTtsRate,
  parseSubtitlePayload,
  partitionIntoSegments,
  selectSegmentForRequest,
} from './subtitle-parser';

describe('subtitle-parser', () => {
  describe('cleanSubtitleText & sound extraction', () => {
    it('strips bracketed annotations globally and extracts sounds', () => {
      const result = cleanSubtitleTextWithSounds(
        '[Music] Hello 【笑声】 world [Applause]',
      );
      expect(result.text).toBe('Hello world');
      expect(result.sounds).toEqual(['Music', '笑声', 'Applause']);
    });

    it('strips leading and trailing non-numeric parentheticals with <= 4 words', () => {
      const result = cleanSubtitleTextWithSounds(
        '- (soft laughter) Welcome everyone! (audience claps softly)',
      );
      expect(result.text).toBe('Welcome everyone!');
      expect(result.sounds).toEqual(['soft laughter', 'audience claps softly']);
    });

    it('strips chained fullwidth parentheticals after punctuation/start while preserving inline CJK notes', () => {
      const result = cleanSubtitleTextWithSounds('（叹气）（笑）你好世界。（掌声）');
      expect(result.text).toBe('你好世界。');
      expect(result.sounds).toEqual(['叹气', '笑', '掌声']);
      expect(cleanSubtitleText('東京（日本）')).toBe('東京（日本）');
    });

    it('preserves parentheticals containing digits or > 4 words', () => {
      expect(cleanSubtitleText('Released (2025) in theaters')).toBe(
        'Released (2025) in theaters',
      );
      expect(cleanSubtitleText('(2025) New edition')).toBe('(2025) New edition');
      expect(
        cleanSubtitleText(
          'Hello world (this has five separate words)',
        ),
      ).toBe('Hello world (this has five separate words)');
    });

    it('returns empty text for sound-only cues while preserving sounds[]', () => {
      const { cues, sounds } = extractSoundsAndCleanCues([
        { start: 1.0, duration: 2.0, text: '[Music]' },
        { start: 1.0, duration: 2.0, text: '[Music]' },
        { start: 3.5, duration: 2.0, text: '(laughs) Hello there.' },
      ]);

      expect(cues).toEqual([
        { start: 3.5, duration: 2.0, text: 'Hello there.' },
      ]);
      expect(sounds).toEqual([
        { start: 1.0, duration: 2.0, text: 'Music' },
        { start: 3.5, duration: 2.0, text: 'laughs' },
      ]);
    });
  });

  describe('parseSubtitlePayload', () => {
    it('parses YouTube JSON3 events and computes fallback durations', () => {
      const json3 = JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
          { tStartMs: 2500, segs: [{ utf8: 'Next line' }] },
          { tStartMs: 5000, dDurationMs: 1800, segs: [{ utf8: 'Final line' }] },
          { tStartMs: 6000, segs: [{ utf8: '\n' }] },
        ],
      });

      const cues = parseSubtitlePayload(json3);
      expect(cues).toEqual([
        { start: 0, duration: 2.5, text: 'Hello world' },
        { start: 2.5, duration: 2.5, text: 'Next line' },
        { start: 5, duration: 1.8, text: 'Final line' },
      ]);
    });

    it('parses XML <transcript><text> with HTML entity decoding', () => {
      const xml = `<?xml version="1.0" encoding="utf-8" ?>
        <transcript>
          <text start="1.5" dur="2.2">Tom &amp; Jerry&#39;s show</text>
          <text start="4.0" dur="1.8">[Music]</text>
        </transcript>`;

      const cues = parseSubtitlePayload(xml);
      expect(cues).toEqual([
        { start: 1.5, duration: 2.2, text: "Tom & Jerry's show" },
        { start: 4, duration: 1.8, text: '[Music]' },
      ]);
    });

    it('parses XML timedtext <p t d><s> format', () => {
      const xml = `<timedtext format="3"><body>
        <p t="1200" d="1500"><s>Hello </s><s>YouTube</s></p>
      </body></timedtext>`;

      const cues = parseSubtitlePayload(xml);
      expect(cues).toEqual([
        { start: 1.2, duration: 1.5, text: 'Hello YouTube' },
      ]);
    });
  });

  describe('mergeCues & alignSourceText', () => {
    it('merges consecutive fragmented cues until sentence end or gap', () => {
      const merged = mergeCues([
        { start: 0, duration: 1.5, text: 'Hello' },
        { start: 1.6, duration: 1.4, text: 'world.' },
        { start: 3.1, duration: 1.5, text: 'Next sentence' },
        { start: 6.0, duration: 1.2, text: 'After a long pause' },
      ]);

      expect(merged).toEqual([
        { start: 0, duration: 3, text: 'Hello world.' },
        { start: 3.1, duration: 1.5, text: 'Next sentence' },
        { start: 6, duration: 1.2, text: 'After a long pause' },
      ]);
    });

    it('aligns sourceText onto target cues by overlapping timestamps', () => {
      const aligned = alignSourceText(
        [{ start: 0, duration: 4, text: 'Xin chào tất cả mọi người.' }],
        [
          { start: 0, duration: 1.8, text: 'Hello' },
          { start: 2.0, duration: 1.9, text: 'everyone.' },
        ],
      );

      expect(aligned).toEqual([
        {
          start: 0,
          duration: 4,
          text: 'Xin chào tất cả mọi người.',
          sourceText: 'Hello everyone.',
        },
      ]);
    });
  });

  describe('partitionIntoSegments & selectSegmentForRequest', () => {
    it('partitions cues into ~45s progressive segments and assigns sounds', () => {
      const cues = [
        { start: 5, duration: 4, text: 'First' },
        { start: 25, duration: 5, text: 'Second' },
        { start: 55, duration: 6, text: 'Third' },
        { start: 110, duration: 4, text: 'Fourth' },
      ];
      const sounds = dedupeAndSortSounds([
        { start: 1, duration: 2, text: 'Intro Music' },
        { start: 56, duration: 1, text: 'Clap' },
      ]);

      const segments = partitionIntoSegments(cues, sounds, 45);
      expect(segments).toHaveLength(3);
      expect(segments[0]).toMatchObject({
        index: 0,
        start: 5,
        end: 30,
        sounds: [{ start: 1, duration: 2, text: 'Intro Music' }],
      });
      expect(segments[1]).toMatchObject({
        index: 1,
        start: 55,
        end: 61,
        sounds: [{ start: 56, duration: 1, text: 'Clap' }],
      });
      expect(segments[2]).toMatchObject({
        index: 2,
        start: 110,
        end: 114,
      });

      // Seeking into silence gap [30, 55] at t=40 maps to segment 1 with mappedFrom=40
      const gapPick = selectSegmentForRequest(segments, { currentTime: 40 });
      expect(gapPick).toEqual({ segment: segments[1], mappedFrom: 40 });

      // Seeking inside segment 0 has no mappedFrom
      const inSegPick = selectSegmentForRequest(segments, { currentTime: 10 });
      expect(inSegPick).toEqual({ segment: segments[0], mappedFrom: undefined });

      // Seeking past end returns last segment
      const pastEnd = selectSegmentForRequest(segments, { currentTime: 999 });
      expect(pastEnd).toEqual({ segment: segments[2], mappedFrom: undefined });

      // Explicit segment index
      expect(selectSegmentForRequest(segments, { segment: 1 })).toEqual({
        segment: segments[1],
      });
      expect(selectSegmentForRequest(segments, { segment: 99 })).toBeNull();
    });
  });

  describe('normalizeTtsRate', () => {
    it('normalizes numeric and SSML percentage rates within [0.5, 2.0]', () => {
      expect(normalizeTtsRate(undefined)).toBe('+0%');
      expect(normalizeTtsRate(1.5)).toBe('+50%');
      expect(normalizeTtsRate(0.8)).toBe('-20%');
      expect(normalizeTtsRate(3.5)).toBe('+100%');
      expect(normalizeTtsRate(0.2)).toBe('-50%');
      expect(normalizeTtsRate('+30%')).toBe('+30%');
      expect(normalizeTtsRate('-80%')).toBe('-50%');
    });
  });
});
