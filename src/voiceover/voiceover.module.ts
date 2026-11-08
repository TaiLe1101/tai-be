import { Module } from '@nestjs/common';
import { VoiceoverService } from './voiceover.service';
import { VoiceoverController } from './voiceover.controller';

@Module({
  providers: [VoiceoverService],
  controllers: [VoiceoverController],
})
export class VoiceoverModule {}
