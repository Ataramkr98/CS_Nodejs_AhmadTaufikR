import { of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './envelope';
import { ProblemDetailsFilter } from './problem';

describe('ResponseEnvelopeInterceptor', () => {
  const context = {
    switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }),
  } as never;

  function envelope(payload: unknown, statusCode = 200) {
    const interceptor = new ResponseEnvelopeInterceptor();
    const ctx = {
      switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
    } as never;
    return new Promise<unknown>((resolve, reject) => {
      interceptor
        .intercept(ctx, { handle: () => of(payload) })
        .subscribe({ next: resolve, error: reject });
    });
  }

  it('wraps a payload with success and message', async () => {
    await expect(envelope({ id: 1 })).resolves.toEqual({
      success: true,
      message: 'OK',
      data: { id: 1 },
    });
  });

  it('normalises an undefined payload to null', async () => {
    await expect(envelope(undefined, 204)).resolves.toEqual({
      success: true,
      message: 'No Content',
      data: null,
    });
  });

  it('reflects the response status in the message', async () => {
    await expect(envelope({ id: 'created' }, 201)).resolves.toMatchObject({
      message: 'Created',
    });
  });

  it('does not touch a context without an HTTP response', () => {
    const interceptor = new ResponseEnvelopeInterceptor();
    expect(() =>
      interceptor.intercept(context, { handle: () => of(1) }),
    ).not.toThrow();
  });
});

describe('ProblemDetailsFilter', () => {
  it('is exported for use as a global filter', () => {
    expect(new ProblemDetailsFilter()).toBeInstanceOf(ProblemDetailsFilter);
  });
});
