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

  it('discovers an anonymous session without a failed HTTP request', () =>
    request(app.getHttpServer())
      .get('/api/auth/me')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual({
          user: null,
          tenant: null,
          canRefresh: false,
        });
      }));

  it('reports an expired access session as refreshable without authenticating it', () =>
    request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', 'csp_access=expired; csp_refresh=refresh-cookie')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual({
          user: null,
          tenant: null,
          canRefresh: true,
        });
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
      .expect('Cross-Origin-Resource-Policy', 'cross-origin')
      .expect((response) => {
        expect(response.text).toContain('data-csp-key');
      }));

  it('allows a customer website to preflight the token-based widget API without cookies', () =>
    request(app.getHttpServer())
      .options('/api/public/widgets/test-key/sessions')
      .set('Origin', 'https://customer-shop.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization')
      .expect(204)
      .expect('Access-Control-Allow-Origin', 'https://customer-shop.example')
      .expect(({ headers }) => {
        expect(headers['access-control-allow-credentials']).toBeUndefined();
        expect(headers['access-control-allow-headers']).toContain(
          'authorization',
        );
      }));

  it('does not allow customer websites to use the cookie-based operator API', () =>
    request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Origin', 'https://customer-shop.example')
      .expect(200)
      .expect(({ headers }) => {
        expect(headers['access-control-allow-origin']).toBeUndefined();
      }));
});
