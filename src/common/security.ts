import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
import { TokenService } from '../auth/token.service';
import { AuthenticatedUser, VisitorSession } from './contracts';

export type AuthenticatedRequest = FastifyRequest & {
  user?: AuthenticatedUser;
  visitor?: VisitorSession;
};

@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const token = request.cookies?.csp_access ?? bearer;
    if (!token) throw new UnauthorizedException('Authentication is required.');
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !bearer
    ) {
      const csrf = request.headers['x-csrf-token'];
      if (
        typeof csrf !== 'string' ||
        !request.cookies?.csp_csrf ||
        csrf !== request.cookies.csp_csrf
      ) {
        throw new ForbiddenException('A valid CSRF token is required.');
      }
    }
    request.user = await this.tokens.verifyOperator(token);
    return true;
  }
}

@Injectable()
export class VisitorGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token)
      throw new UnauthorizedException('A widget visitor token is required.');
    request.visitor = await this.tokens.verifyVisitor(token);
    return true;
  }
}

export const requireRole = (
  user: AuthenticatedUser,
  ...roles: UserRole[]
): void => {
  if (!roles.includes(user.role)) {
    // 403, not 401: the caller is authenticated, just not permitted. A 401 here
    // makes the web client treat it as an expired session and needlessly
    // bounce the user to the login screen.
    throw new ForbiddenException('Your role cannot perform this action.');
  }
};
