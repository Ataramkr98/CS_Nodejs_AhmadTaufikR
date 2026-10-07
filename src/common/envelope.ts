import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { Observable, map } from 'rxjs';

/**
 * Every JSON response leaves the API in the same shape:
 *
 * ```json
 * { "success": true, "message": "OK", "data": { ... } }
 * ```
 *
 * Errors keep the RFC 7807 `application/problem+json` shape produced by
 * `ProblemDetailsFilter`, so clients can branch on `success` for the happy path
 * and on `status`/`detail` for failures without guessing at the payload.
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<
  T,
  unknown
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    return next.handle().pipe(
      map((payload) => ({
        success: true,
        message: statusText(reply.statusCode),
        data: payload === undefined ? null : payload,
      })),
    );
  }
}

function statusText(status: number): string {
  if (status === 201) return 'Created';
  if (status === 204) return 'No Content';
  if (status >= 400) return 'Error';
  return 'OK';
}
