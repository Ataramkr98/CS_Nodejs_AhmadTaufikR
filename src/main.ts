import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: isProduction ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    }),
  );

  await configureApp(app);

  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });

  if (!isProduction) {
    console.log(`CS Pintar API ready on http://localhost:${port}`);
    console.log(`Swagger UI:  http://localhost:${port}/api/docs`);
    console.log(`Widget:      http://localhost:${port}/widget.js`);
  }
}

void bootstrap();
