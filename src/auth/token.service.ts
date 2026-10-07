import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { generateKeyPairSync } from 'crypto';
import { AuthenticatedUser, VisitorSession } from '../common/contracts';

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly privateKey: string;
  private readonly publicKey: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    const configuredPrivate = config
      .get<string>('JWT_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');
    const configuredPublic = config
      .get<string>('JWT_PUBLIC_KEY')
      ?.replace(/\\n/g, '\n');
    if (configuredPrivate && configuredPublic) {
      this.privateKey = configuredPrivate;
      this.publicKey = configuredPublic;
      return;
    }

    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();
    this.publicKey = pair.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    this.logger.warn(
      'JWT PEM keys are not configured; using ephemeral RS256 keys for this process.',
    );
  }

  issueOperator(user: {
    id: string;
    tenantId: string;
    email: string;
    role: UserRole;
  }): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
        kind: 'operator',
      },
      { algorithm: 'RS256', privateKey: this.privateKey, expiresIn: '15m' },
    );
  }

  issueVisitor(session: {
    customerId: string;
    tenantId: string;
    conversationId: string;
  }): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: session.customerId,
        tenantId: session.tenantId,
        conversationId: session.conversationId,
        kind: 'visitor',
      },
      { algorithm: 'RS256', privateKey: this.privateKey, expiresIn: '7d' },
    );
  }

  /**
   * Verification failures must surface as 401, never 500: `ProblemDetailsFilter`
   * maps any non-HttpException to INTERNAL_SERVER_ERROR, and the web client keys
   * its "session expired -> refresh" flow off a 401. A raw `TokenExpiredError`
   * leaking out would therefore read as a server fault and strand the user.
   */
  private async verify<T extends object>(
    token: string,
    kind: string,
  ): Promise<T> {
    let payload: T;
    try {
      payload = await this.jwt.verifyAsync<T>(token, {
        algorithms: ['RS256'],
        publicKey: this.publicKey,
      });
    } catch (error) {
      const expired =
        error instanceof Error &&
        (error.name === 'TokenExpiredError' ||
          /expired/i.test((error as { message?: string }).message ?? ''));
      throw new UnauthorizedException(
        expired ? 'Session has expired.' : `Invalid ${kind} token.`,
      );
    }
    return payload;
  }

  async verifyOperator(token: string): Promise<AuthenticatedUser> {
    const payload = await this.verify<AuthenticatedUser>(token, 'operator');
    if (payload.kind !== 'operator' || !payload.tenantId || !payload.sub)
      throw new UnauthorizedException('Invalid operator token.');
    return payload;
  }

  async verifyVisitor(token: string): Promise<VisitorSession> {
    const payload = await this.verify<VisitorSession>(token, 'visitor');
    if (
      payload.kind !== 'visitor' ||
      !payload.tenantId ||
      !payload.conversationId
    )
      throw new UnauthorizedException('Invalid visitor token.');
    return payload;
  }

  async signState(returnTo?: string): Promise<string> {
    return this.jwt.signAsync(
      { kind: 'oauth-state', returnTo },
      { algorithm: 'RS256', privateKey: this.privateKey, expiresIn: '10m' },
    );
  }

  async verifyState(
    token: string,
  ): Promise<{ kind: string; returnTo?: string }> {
    try {
      return await this.verify<{ kind: string; returnTo?: string }>(
        token,
        'oauth-state',
      );
    } catch {
      throw new UnauthorizedException('Invalid OAuth state.');
    }
  }
}
