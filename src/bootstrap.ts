import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'path';
import { ResponseEnvelopeInterceptor } from './common/envelope';
import { ProblemDetailsFilter } from './common/problem';

/**
 * Single place where the HTTP surface is wired: plugins, CORS, the error
 * filter and the response envelope.
 *
 * `main.ts` and the e2e suite both call this, so the contract the tests assert
 * is the same contract production serves.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(multipart, {
    limits: {
      fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
      files: 1,
    },
  });
  // The embeddable web-chat widget is a plain static asset so a customer's site
  // can load it with a single `<script src="…/widget.js">` tag.
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
    index: false,
    wildcard: false,
  });

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    credentials: true,
    // @fastify/cors defaults to `GET,HEAD,POST`, which silently blocks every
    // mutating request (settings save, provider toggles, KB upload) that the
    // browser sends cross-origin from the web app.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.setGlobalPrefix('');

  // Errors → RFC 7807 problem documents, successes → `{ success, message, data }`.
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  const swagger = new DocumentBuilder()
    .setTitle('CS Pintar API')
    .setDescription('Multi-tenant AI customer service backend')
    .setVersion('1.0.0')
    .addCookieAuth('csp_access')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swagger),
  );
}
