import { BadRequestException, HttpStatus } from '@nestjs/common';
import {
  ProblemDetailsFilter,
  featureUnavailable,
  PROBLEM_TYPES,
} from './problem';

describe('featureUnavailable', () => {
  it('returns an RFC 9457-compatible 501 response', () => {
    const exception = featureUnavailable('WhatsApp');

    expect(exception.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
    expect(exception.getResponse()).toMatchObject({
      type: PROBLEM_TYPES.featureUnavailable,
      title: 'Feature unavailable',
      status: HttpStatus.NOT_IMPLEMENTED,
    });
  });

  it('names the feature it refused, so 501s are debuggable', () => {
    const exception = featureUnavailable('Scheduled export');
    expect((exception.getResponse() as { detail: string }).detail).toContain(
      'Scheduled export',
    );
  });

  it('uses URN problem types rather than dead URLs', () => {
    // A problem `type` is a URI reference that identifies the problem, not a
    // documentation link. Pointing it at a domain that does not serve the page
    // would put a dead link in every error response.
    for (const value of Object.values(PROBLEM_TYPES)) {
      expect(value.startsWith('urn:')).toBe(true);
      expect(value).not.toMatch(/^https?:/);
    }
  });
});

describe('ProblemDetailsFilter', () => {
  const reply = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type(value: string) {
      this.headers['content-type'] = value;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const host = () =>
    ({
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ url: '/api/example' }),
      }),
    }) as never;

  beforeEach(() => {
    reply.statusCode = 0;
    reply.body = undefined;
  });

  it('wraps an HttpException into a problem document', () => {
    new ProblemDetailsFilter().catch(
      new BadRequestException({ message: 'nope', statusCode: 400 }),
      host(),
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.headers['content-type']).toBe('application/problem+json');
    expect(reply.body).toMatchObject({
      type: 'about:blank',
      status: 400,
      instance: '/api/example',
    });
  });

  it('never leaks an unknown error as a 500 with a raw message', () => {
    new ProblemDetailsFilter().catch(
      new Error('connection string postgres://user:hunter2@db/x failed'),
      host(),
    );

    expect(reply.statusCode).toBe(500);
    const body = reply.body as { detail: string };
    expect(body.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toMatch(/hunter2/);
  });
});
