import { Controller, Post, Get, Body, Query } from '@nestjs/common';
import { VoiceoverService, SubtitleSegment } from './voiceover.service';

@Controller('voiceover')
export class VoiceoverController {
  constructor(private readonly voiceoverService: VoiceoverService) {}

  @Post('start')
  async start(
    @Body('videoId') videoId: string,
    @Body('subtitles') subtitles?: SubtitleSegment[],
  ) {
    return this.voiceoverService.startVoiceover(videoId, subtitles);
  }

  @Get('chunks')
  getChunks(
    @Query('videoId') videoId: string,
    @Query('fromTime') fromTime: string,
  ) {
    const time = parseFloat(fromTime) || 0;
    const chunks = this.voiceoverService.getReadyChunks(videoId, time);
    return { chunks };
  }
}
