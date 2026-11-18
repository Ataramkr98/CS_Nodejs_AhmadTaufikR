import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
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
  const fastify: FastifyInstance = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.url.split('?')[0] === '/widget.js') {
      // This script is intentionally embedded on customer websites. Keep
      // Helmet's same-origin resource policy for every other response.
      reply.header('cross-origin-resource-policy', 'cross-origin');
    }
    return payload;
  });
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

  const operatorOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    delegator: (request, callback) => {
      // Widgets run on customer websites, independently of the operator
      // console's cookie-based CORS allowlist. Their controllers validate the
      // tenant's allowedOrigins, and transcript access requires a visitor token.
      const isPublic = request.url.startsWith('/api/public/');
      callback(null, {
        origin: isPublic ? true : operatorOrigins,
        credentials: !isPublic,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      });
    },
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
