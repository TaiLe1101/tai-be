import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { VoiceoverController } from './voiceover/voiceover.controller';
import { VoiceoverService } from './voiceover/voiceover.service';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'storage/audio'),
      serveRoot: '/audio',
    }),
  ],
  controllers: [VoiceoverController],
  providers: [VoiceoverService],
})
export class AppModule {}
