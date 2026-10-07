import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    title: string,
    detail: string,
    type = 'about:blank',
    errors?: unknown,
  ) {
    super({ type, title, status, detail, errors }, status);
  }
}

/**
 * Problem types are URNs rather than URLs: RFC 7807 wants a URI reference that
 * identifies the problem type, and pointing at a domain that does not serve
 * documentation for it would be a dead link in every error response.
 */
export const PROBLEM_TYPES = {
  validation: 'urn:cs-pintar:problem:validation',
  featureUnavailable: 'urn:cs-pintar:problem:feature-unavailable',
} as const;

export const featureUnavailable = (feature: string) =>
  new ProblemException(
    HttpStatus.NOT_IMPLEMENTED,
    'Feature unavailable',
    `${feature} is declared on the product roadmap but is not implemented in this build.`,
    PROBLEM_TYPES.featureUnavailable,
  );

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<{ url: string }>();
    const httpException =
      exception instanceof HttpException ? exception : undefined;
    const status =
      httpException?.getStatus() ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = httpException?.getResponse();
    const body: Record<string, unknown> =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const title =
      typeof body['title'] === 'string' ? body['title'] : HttpStatus[status];
    const detail =
      typeof body['detail'] === 'string'
        ? body['detail']
        : typeof body['message'] === 'string'
          ? body['message']
          : 'An unexpected error occurred.';

    void response
      .status(status)
      .type('application/problem+json')
      .send({
        type: typeof body['type'] === 'string' ? body['type'] : 'about:blank',
        title,
        status,
        detail,
        instance: request.url,
        ...(body['errors'] ? { errors: body['errors'] } : {}),
      });
  }
}
