import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

export interface VoiceChunk {
  id: number;
  start: number;
  end: number;
  text: string;
  audioUrl: string;
  status: 'PENDING' | 'READY';
}

@Injectable()
export class VoiceoverService {
  private readonly logger = new Logger(VoiceoverService.name);

  // Điền đúng URL trycloudflare.com hiện tại từ Google Colab
  private colabWorkerUrl =
    'https://app-essentially-mixer-saying.trycloudflare.com';
  private processingVideos: Set<string> = new Set();

  setColabUrl(url: string) {
    this.colabWorkerUrl = url.replace(/\/$/, '');
    this.logger.log(`URL Colab Worker: ${this.colabWorkerUrl}`);
  }

  private getStorageDir(videoId: string): string {
    const dir = path.join(process.cwd(), 'storage/audio', videoId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // Thuật toán làm phẳng timeline: loại bỏ overlap, cắt biên và gộp cụm từ hợp lý
  normalizeTimeline(subs: SubtitleSegment[]): SubtitleSegment[] {
    if (!subs || subs.length === 0) return [];

    // Lọc bỏ âm thanh nền dạng [Music], [Applause] hoặc chuỗi trống
    const validSubs = subs
      .map((s) => ({
        start: Number(Number(s.start).toFixed(2)),
        end: Number(Number(s.end).toFixed(2)),
        text: (s.text || '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      }))
      .filter((s) => s.text.length > 0 && !/^\[.*\]$/.test(s.text));

    if (validSubs.length === 0) return [];

    // Sắp xếp tuần tự theo mốc thời gian bắt đầu
    validSubs.sort((a, b) => a.start - b.start);

    const result: SubtitleSegment[] = [];
    let current: SubtitleSegment = { ...validSubs[0] };

    for (let i = 1; i < validSubs.length; i++) {
      const next = validSubs[i];

      // Bỏ qua các đoạn bị lùi thời gian sâu do artifact của rolling cue
      if (next.start < current.start) {
        continue;
      }

      const gap = Number((next.start - current.end).toFixed(2));
      const currentDuration = Number((current.end - current.start).toFixed(2));

      // Gộp câu nếu khoảng nghỉ ngắn (<= 0.6s), độ dài chưa vượt quá 5.5s và câu chưa kết thúc bằng dấu chấm
      if (gap <= 0.6 && currentDuration < 5.5 && !/[.?!]$/.test(current.text)) {
        if (!current.text.toLowerCase().includes(next.text.toLowerCase())) {
          current.text = `${current.text} ${next.text}`.trim();
        }
        current.end = Math.max(current.end, next.end);
      } else {
        // Cắt biên: kết thúc của câu trước không được đè sang thời điểm bắt đầu của câu kế tiếp
        if (current.end > next.start) {
          current.end = next.start;
        }

        // Chỉ đưa vào danh sách nếu đoạn thoại có độ dài tối thiểu từ 0.4s trở lên
        if (current.end - current.start >= 0.4) {
          result.push({
            start: Number(current.start.toFixed(2)),
            end: Number(current.end.toFixed(2)),
            text: current.text,
          });
        }

        current = { ...next };
      }
    }

    if (current.end - current.start >= 0.4) {
      result.push({
        start: Number(current.start.toFixed(2)),
        end: Number(current.end.toFixed(2)),
        text: current.text,
      });
    }

    return result;
  }

  // Tải trực tiếp phụ đề json3 qua yt-dlp để tránh cấu trúc lặp 3 dòng của VTT
  async extractSubtitles(videoId: string): Promise<SubtitleSegment[]> {
    const tempDir = path.join(process.cwd(), 'storage/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const outputTemplate = path.join(tempDir, `${videoId}.%(ext)s`);

    try {
      await execFileAsync(
        'yt-dlp',
        [
          '--skip-download',
          '--write-auto-sub',
          '--write-sub',
          '--sub-lang',
          'en.*,en',
          '--sub-format',
          'json3',
          '-o',
          outputTemplate,
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        { maxBuffer: 50 * 1024 * 1024 },
      );

      const files = fs.readdirSync(tempDir);
      const targetSubFile = files.find(
        (f) => f.startsWith(videoId) && f.endsWith('.json3'),
      );

      if (!targetSubFile) {
        this.logger.warn(
          `Không tìm thấy file phụ đề json3 cho video: ${videoId}`,
        );
        return [];
      }

      const filePath = path.join(tempDir, targetSubFile);
      const rawContent = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(rawContent);

      // Xóa file phụ đề tạm
      files
        .filter((f) => f.startsWith(videoId))
        .forEach((f) => {
          try {
            fs.unlinkSync(path.join(tempDir, f));
          } catch (_) {}
        });

      const rawSegments: SubtitleSegment[] = [];
      for (const ev of data.events || []) {
        if (
          !ev.segs ||
          ev.tStartMs === undefined ||
          ev.dDurationMs === undefined
        )
          continue;

        const text = ev.segs
          .map((s: any) => s.utf8 || '')
          .join('')
          .replace(/[\r\n]+/g, ' ')
          .trim();

        if (!text || text === '\n') continue;

        const start = Number((ev.tStartMs / 1000).toFixed(2));
        const duration = Number((ev.dDurationMs / 1000).toFixed(2));
        const end = Number((start + duration).toFixed(2));

        rawSegments.push({ start, end, text });
      }

      return this.normalizeTimeline(rawSegments);
    } catch (error: any) {
      this.logger.error(`Lỗi trích xuất sub bằng yt-dlp: ${error.message}`);
      return [];
    }
  }

  async startVoiceover(videoId: string, clientSubs?: SubtitleSegment[]) {
    const storageDir = this.getStorageDir(videoId);
    const subCachePath = path.join(storageDir, 'subtitles.json');

    let subs: SubtitleSegment[] = [];

    // 1. Kiểm tra cache transcript local
    if (fs.existsSync(subCachePath)) {
      this.logger.log(`[CACHE HIT] Đọc phụ đề local: ${videoId}`);
      subs = JSON.parse(fs.readFileSync(subCachePath, 'utf-8'));
    }
    // 2. Nhận từ Chrome Extension gửi lên
    else if (clientSubs && clientSubs.length > 0) {
      this.logger.log(
        `[EXTENSION] Nhận phụ đề trực tiếp từ client: ${videoId}`,
      );
      subs = this.normalizeTimeline(clientSubs);
      fs.writeFileSync(subCachePath, JSON.stringify(subs, null, 2), 'utf-8');
    }
    // 3. Fallback tải qua yt-dlp khi test bằng cURL
    else {
      this.logger.log(`[FALLBACK] Gọi yt-dlp tải json3: ${videoId}`);
      subs = await this.extractSubtitles(videoId);
      if (subs.length > 0) {
        fs.writeFileSync(subCachePath, JSON.stringify(subs, null, 2), 'utf-8');
      }
    }

    if (!subs || subs.length === 0) {
      return { status: 'NO_SUBTITLES' };
    }

    // Khởi tạo danh sách chunk âm thanh kèm kiểm tra file MP3 sẵn có
    const chunks: VoiceChunk[] = subs.map((s, idx) => {
      const audioFileName = `chunk_${idx}.mp3`;
      const isFileExist = fs.existsSync(path.join(storageDir, audioFileName));

      return {
        id: idx,
        start: s.start,
        end: s.end,
        text: s.text,
        audioUrl: `/audio/${videoId}/${audioFileName}`,
        status: isFileExist ? 'READY' : 'PENDING',
      };
    });

    const missingChunks = chunks.filter((c) => c.status === 'PENDING');

    if (missingChunks.length === 0) {
      this.logger.log(
        `[FULL CACHE] Toàn bộ file audio đã có sẵn cho video: ${videoId}`,
      );
      return { status: 'READY', cached: true };
    }

    // Xử lý trước 5 câu đầu tiên để người dùng nghe được ngay
    const initialBatch = missingChunks.slice(0, 5);
    await this.processBatch(videoId, initialBatch);

    // Xử lý các câu còn lại trong background worker
    if (missingChunks.length > 5 && !this.processingVideos.has(videoId)) {
      this.processingVideos.add(videoId);
      this.processBackground(videoId, missingChunks.slice(5));
    }

    return { status: 'BUFFERED_FIRST_CHUNKS' };
  }

  private async processBatch(videoId: string, batch: VoiceChunk[]) {
    const storageDir = this.getStorageDir(videoId);

    for (const chunk of batch) {
      const filePath = path.join(storageDir, `chunk_${chunk.id}.mp3`);
      if (fs.existsSync(filePath)) {
        chunk.status = 'READY';
        continue;
      }

      try {
        const response = await axios.post(
          `${this.colabWorkerUrl}/process-tts`,
          { text: chunk.text, target_lang: 'vi' },
          { responseType: 'arraybuffer', timeout: 35000 },
        );

        fs.writeFileSync(filePath, Buffer.from(response.data));
        chunk.status = 'READY';
      } catch (err: any) {
        this.logger.error(`Lỗi render chunk ${chunk.id}: ${err.message}`);
      }
    }
  }

  private async processBackground(
    videoId: string,
    remainingChunks: VoiceChunk[],
  ) {
    const batchSize = 10;
    for (let i = 0; i < remainingChunks.length; i += batchSize) {
      const batch = remainingChunks.slice(i, i + batchSize);
      await this.processBatch(videoId, batch);
    }
    this.processingVideos.delete(videoId);
    this.logger.log(`Hoàn thành toàn bộ audio cho video: ${videoId}`);
  }

  getReadyChunks(videoId: string, fromTime: number) {
    const storageDir = this.getStorageDir(videoId);
    const subCachePath = path.join(storageDir, 'subtitles.json');

    if (!fs.existsSync(subCachePath)) return [];

    const subs: SubtitleSegment[] = JSON.parse(
      fs.readFileSync(subCachePath, 'utf-8'),
    );

    return subs
      .map((s, idx) => {
        const audioFileName = `chunk_${idx}.mp3`;
        const exists = fs.existsSync(path.join(storageDir, audioFileName));
        return {
          id: idx,
          start: s.start,
          end: s.end,
          text: s.text,
          audioUrl: `/audio/${videoId}/${audioFileName}`,
          status: exists ? 'READY' : 'PENDING',
        };
      })
      .filter((c) => c.status === 'READY' && c.start >= fromTime)
      .slice(0, 20);
  }
}
