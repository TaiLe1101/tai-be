import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

import { NestExpressApplication } from '@nestjs/platform-express';
import {
  DocumentBuilder,
  SwaggerCustomOptions,
  SwaggerModule,
} from '@nestjs/swagger';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { HttpExceptionFilter } from '~/filters/http-exception.filter';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('MAIN');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  const uploadsDir = join(process.cwd(), 'uploads');
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }
  app.useStaticAssets(uploadsDir, {
    prefix: '/uploads/',
  });

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV');
  const port = configService.get<number>('PORT', 3000);
  const appName = configService.get<string>('APP_NAME', 'Saas Office API');
  const corsOriginsClient = configService.get<string>('CORS_ORIGINS_CLIENT')
    ? configService.get<string>('CORS_ORIGINS_CLIENT')!.split(';')
    : [];

  app.use(cookieParser());
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
  app.use(bodyParser.raw({ limit: '10mb' }));

  app.setGlobalPrefix('api');

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    }),
  );

  app.enableCors({
    origin: corsOriginsClient,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
      'x-api-key',
      'X-API-KEY',
    ],
    maxAge: 86400,
  });

  app.useGlobalFilters(new HttpExceptionFilter());

  if (nodeEnv === 'dev' || nodeEnv === 'test') {
    // Swagger configuration
    const config = new DocumentBuilder()
      .setTitle(appName)
      .setDescription(`API documentation for ${appName} (${nodeEnv})`)
      .setVersion('1.0.0')

      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          in: 'header',
          name: 'Authorization',
        },
        'JWT-Auth',
      )
      // .addApiKey(
      //   {
      //     type: 'apiKey',
      //     name: 'x-api-key',
      //     in: 'header',
      //     description: 'API Key cho Public API',
      //   },
      //   'API-Key',
      // )
      .build();
    const document = SwaggerModule.createDocument(app, config, {
      operationIdFactory: (controllerKey: string, methodKey: string) =>
        `${controllerKey}_${methodKey}`,
      deepScanRoutes: true,
    });

    const swaggerCustomOptions: SwaggerCustomOptions = {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
      explorer: true,
    };

    SwaggerModule.setup('api/docs', app, document, swaggerCustomOptions);
  }

  await app.listen(port);

  logger.log(
    `Ứng dụng ${appName} đang chạy trên port ${port} với URL: http://localhost:${port}`,
  );
}
bootstrap();
