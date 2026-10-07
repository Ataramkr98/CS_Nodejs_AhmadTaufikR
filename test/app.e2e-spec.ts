import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from '../src/bootstrap';

describe('API contract (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    // Same bootstrap the production server uses, so the assertions below check
    // the real contract rather than a stripped-down test app.
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('wraps successful responses in { success, message, data }', () =>
    request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          success: true,
          message: 'OK',
          data: { status: 'ok', service: 'cs-pintar-api' },
        });
      }));

  it('reports errors as application/problem+json', () =>
    request(app.getHttpServer())
      .get('/api/capabilities')
      .expect(401)
      .expect('Content-Type', /application\/problem\+json/)
      .expect((response) => {
        expect(response.body).toMatchObject({ status: 401 });
        expect(typeof response.body.detail).toBe('string');
      }));

  it('serves the capability matrix without authentication', () =>
    request(app.getHttpServer())
      .get('/api/public/capabilities')
      .expect(200)
      .expect((response) => {
        expect(response.body.success).toBe(true);
        const { capabilities } = response.body.data;
        expect(Array.isArray(capabilities)).toBe(true);
        // Every advertised capability must declare an explicit availability so
        // the marketing page can never show an unavailable feature as shipped.
        for (const capability of capabilities) {
          expect(typeof capability.available).toBe('boolean');
          expect(typeof capability.label).toBe('string');
        }
      }));

  it('serves the embeddable widget as a static asset', () =>
    request(app.getHttpServer())
      .get('/widget.js')
      .expect(200)
      .expect('Content-Type', /javascript/)
      .expect((response) => {
        expect(response.text).toContain('data-csp-key');
      }));
});
