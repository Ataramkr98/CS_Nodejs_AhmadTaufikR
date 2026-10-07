import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { OperatorGuard } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { parseInput } from '../common/validation';
import { AuthService } from './auth.service';

const signupSchema = z.object({
  tenantName: z.string().trim().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(12).max(128),
  name: z.string().trim().min(1).max(120).optional(),
});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(128),
});

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('signup')
  async signup(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.setSession(
      reply,
      await this.auth.signup(parseInput(signupSchema, body)),
    );
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(loginSchema, body);
    return this.setSession(
      reply,
      await this.auth.login(input.email, input.password),
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.setSession(
      reply,
      await this.auth.refresh(request.cookies?.csp_refresh ?? ''),
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(request.cookies?.csp_refresh);
    const cookieDomain = this.config.get('COOKIE_DOMAIN') || undefined;
    const cookiePath = '/';
    reply
      .clearCookie('csp_access', { path: cookiePath, domain: cookieDomain })
      .clearCookie('csp_refresh', { path: cookiePath, domain: cookieDomain })
      .clearCookie('csp_csrf', { path: cookiePath, domain: cookieDomain });
  }

  @Post('password')
  @UseGuards(OperatorGuard)
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = parseInput(passwordSchema, body);
    await this.auth.changePassword(
      request.user!.tenantId,
      request.user!.sub,
      input.currentPassword,
      input.newPassword,
    );
    return { ok: true };
  }

  /**
   * Returns the operator and tenant behind the current session cookies.
   * The frontend calls this on mount so a page refresh restores the session
   * instead of dropping the user back to the login screen.
   */
  @Get('me')
  @UseGuards(OperatorGuard)
  async me(@Req() request: AuthenticatedRequest) {
    const session = await this.auth.currentSession(
      request.user!.tenantId,
      request.user!.sub,
    );
    return { user: session.user, tenant: session.tenant };
  }

  @Get('google')
  async google(@Query('returnTo') returnTo?: string) {
    return {
      authorizationUrl: await this.auth.googleAuthorizationUrl(returnTo),
    };
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.setSession(reply, await this.auth.loginGoogle(code, state));
  }

  /**
   * Cookie flags are configurable because a deployment behind TLS termination
   * sets `secure=true` explicitly, and a split-domain frontend
   * (`app.example.com` + `api.example.com`) needs `SameSite=None`, which
   * browsers only accept together with `secure`.
   */
  private setSession(
    reply: FastifyReply,
    session: Awaited<ReturnType<AuthService['login']>>,
  ) {
    const secure =
      this.config.get('COOKIE_SECURE') === 'true' ||
      (this.config.get('COOKIE_SECURE') !== 'false' &&
        this.config.get('NODE_ENV') === 'production');
    const sameSite = this.config.get<'lax' | 'strict' | 'none'>(
      'COOKIE_SAMESITE',
      'lax',
    );
    const domain = this.config.get('COOKIE_DOMAIN') || undefined;
    const accessTtl = Number(this.config.get('ACCESS_TTL') ?? 900);
    const refreshTtl = Number(this.config.get('REFRESH_TTL') ?? 604_800);
    const csrf = randomToken();

    reply
      .setCookie('csp_access', session.accessToken, {
        httpOnly: true,
        secure,
        sameSite,
        domain,
        path: '/',
        maxAge: accessTtl,
      })
      .setCookie('csp_refresh', session.refreshToken, {
        httpOnly: true,
        secure,
        sameSite,
        domain,
        path: '/',
        maxAge: refreshTtl,
      })
      .setCookie('csp_csrf', csrf, {
        // Readable by the browser on purpose: the client echoes it back in the
        // `x-csrf-token` header for double-submit validation.
        httpOnly: false,
        secure,
        sameSite,
        domain,
        path: '/',
        maxAge: refreshTtl,
      });
    return { user: session.user, tenant: session.tenant, csrfToken: csrf };
  }
}

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}
