import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderKind, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { TokenService } from './token.service';
import { AI_MODEL_IDS } from '../ai/ai.config';

interface SignupInput {
  tenantName: string;
  email: string;
  password: string;
  name?: string;
}

interface SessionResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string | null; role: UserRole };
  tenant: { id: string; name: string; widgetKey: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {}

  async signup(input: SignupInput): Promise<SessionResult> {
    const email = input.email.toLowerCase();
    const exists = await this.findByEmail(email);
    if (exists)
      throw new ConflictException('An account already exists for this email.');

    const tenantId = randomUUID();
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
    const tenant = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenant.create({
        data: {
          id: tenantId,
          name: input.tenantName,
          widgetKey: randomUUID(),
          settings: { create: {} },
          users: {
            create: {
              email,
              name: input.name,
              passwordHash,
              role: UserRole.OWNER,
            },
          },
          providerConfigs: {
            create: [
              // Shared gateway first: cheapest and fastest, so it wins routing
              // whenever AI_API_KEY is configured. kimi-k3 is seeded disabled
              // because it is the most expensive fallback; a tenant opts in.
              {
                provider: ProviderKind.AUTOAPP,
                model: AI_MODEL_IDS.MINIMAX_M3,
                enabled: true,
                priority: 1,
              },
              {
                provider: ProviderKind.AUTOAPP,
                model: AI_MODEL_IDS.GLM_53_FLASH,
                enabled: true,
                priority: 2,
              },
              {
                provider: ProviderKind.AUTOAPP,
                model: AI_MODEL_IDS.KIMI_K3,
                enabled: false,
                priority: 3,
              },
              {
                provider: ProviderKind.GROQ,
                model: this.config.get(
                  'GROQ_PRIMARY_MODEL',
                  'llama-3.3-70b-versatile',
                ),
                enabled: true,
                priority: 10,
              },
              {
                provider: ProviderKind.GROQ,
                model: this.config.get(
                  'GROQ_BURST_MODEL',
                  'llama-3.1-8b-instant',
                ),
                enabled: true,
                priority: 20,
              },
              {
                provider: ProviderKind.GEMINI,
                model: this.config.get('GEMINI_MODEL', 'gemini-2.5-flash'),
                enabled: false,
                priority: 50,
              },
              {
                provider: ProviderKind.OPENROUTER,
                model: 'openrouter/free',
                enabled: false,
                priority: 70,
              },
              {
                provider: ProviderKind.OLLAMA,
                model: this.config.get('OLLAMA_MODEL', 'llama3.1:8b'),
                enabled: false,
                priority: 30,
              },
              {
                provider: ProviderKind.DEMO,
                model: 'csp-demo-v1',
                enabled: this.config.get('AI_MODE') === 'demo',
                priority: 999,
              },
            ],
          },
        },
        include: { users: true },
      }),
    );
    return this.issueSession(tenant.users[0], tenant);
  }

  async login(emailInput: string, password: string): Promise<SessionResult> {
    const email = emailInput.toLowerCase();
    const user = await this.findByEmail(email);
    if (
      !user?.passwordHash ||
      !(await argon2.verify(user.passwordHash, password))
    ) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const tenant = await this.prisma.withTenant(user.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } }),
    );
    return this.issueSession(user, tenant);
  }

  /**
   * Resolves the operator behind an already-verified access token.
   *
   * The access token only carries `sub`/`tenantId`/`role`/`email`, so the
   * display name is re-read from the database. This is what makes session
   * restore on a full page reload possible.
   */
  async currentSession(
    tenantId: string,
    userId: string,
  ): Promise<SessionResult> {
    const user = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { id: userId, tenantId } }),
    );
    if (!user) throw new UnauthorizedException('Session is no longer valid.');
    const tenant = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    );
    return {
      accessToken: '',
      refreshToken: '',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      tenant: { id: tenant.id, name: tenant.name, widgetKey: tenant.widgetKey },
    };
  }

  async refresh(refreshToken: string): Promise<SessionResult> {
    const separator = refreshToken.indexOf('.');
    if (separator <= 0)
      throw new UnauthorizedException('Invalid refresh token.');
    const tenantId = refreshToken.slice(0, separator);
    const hash = this.hashToken(refreshToken);
    const record = await this.prisma.withTenant(tenantId, (tx) =>
      tx.refreshToken.findFirst({
        where: {
          tenantId,
          tokenHash: hash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        include: { user: true, tenant: true },
      }),
    );
    if (!record)
      throw new UnauthorizedException('Refresh token is expired or revoked.');
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: new Date() },
      }),
    );
    return this.issueSession(record.user, record.tenant);
  }

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    const separator = refreshToken.indexOf('.');
    if (separator <= 0) return;
    const tenantId = refreshToken.slice(0, separator);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.refreshToken.updateMany({
        where: {
          tenantId,
          tokenHash: this.hashToken(refreshToken),
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
    );
  }

  async changePassword(
    tenantId: string,
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { id: userId, tenantId } }),
    );
    if (
      !user?.passwordHash ||
      !(await argon2.verify(user.passwordHash, currentPassword))
    ) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    const passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
    });
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordHash, updatedAt: new Date() },
      }),
    );
  }

  async googleAuthorizationUrl(returnTo?: string): Promise<string> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const redirectUri = this.config.get<string>('GOOGLE_CALLBACK_URL');
    if (!clientId || !redirectUri)
      throw new UnauthorizedException('Google OAuth is not configured.');
    const state = await this.tokens.signState(returnTo);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async loginGoogle(code: string, state: string): Promise<SessionResult> {
    const statePayload = await this.tokens.verifyState(state);
    if (statePayload.kind !== 'oauth-state')
      throw new UnauthorizedException('Invalid OAuth state.');
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('GOOGLE_CALLBACK_URL');
    if (!clientId || !clientSecret || !redirectUri)
      throw new UnauthorizedException('Google OAuth is not configured.');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok)
      throw new UnauthorizedException('Google OAuth exchange failed.');
    const token = (await tokenResponse.json()) as { access_token: string };
    const profileResponse = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      {
        headers: { authorization: `Bearer ${token.access_token}` },
      },
    );
    if (!profileResponse.ok)
      throw new UnauthorizedException('Google profile lookup failed.');
    const profile = (await profileResponse.json()) as {
      sub: string;
      email: string;
      name?: string;
    };
    const existingUser = await this.findByEmail(profile.email.toLowerCase());
    if (!existingUser) {
      return this.signup({
        tenantName: `${profile.name ?? 'Google'} workspace`,
        email: profile.email,
        password: randomBytes(32).toString('base64url'),
        name: profile.name,
      });
    }
    let user = existingUser;
    if (!existingUser.googleId) {
      user = await this.prisma.withTenant(existingUser.tenantId, (tx) =>
        tx.user.update({
          where: { id: existingUser.id },
          data: { googleId: profile.sub },
        }),
      );
    }
    const tenant = await this.prisma.withTenant(user.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } }),
    );
    return this.issueSession(user, tenant);
  }

  private async findByEmail(email: string) {
    return this.prisma.withLoginEmail(email, (tx) =>
      tx.user.findUnique({ where: { email } }),
    );
  }

  private async issueSession(
    user: {
      id: string;
      tenantId: string;
      email: string;
      name: string | null;
      role: UserRole;
    },
    tenant: { id: string; name: string; widgetKey: string },
  ): Promise<SessionResult> {
    const accessToken = await this.tokens.issueOperator(user);
    const refreshToken = `${tenant.id}.${randomBytes(32).toString('base64url')}`;
    await this.prisma.withTenant(tenant.id, (tx) =>
      tx.refreshToken.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          tokenHash: this.hashToken(refreshToken),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      }),
    );
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      // Rebuilt explicitly rather than passed through. Callers hand in tenant
      // records with different `include`s — signup passes one with
      // `include: { users: true }`, which would otherwise serialise every
      // user's passwordHash into the signup response.
      tenant: {
        id: tenant.id,
        name: tenant.name,
        widgetKey: tenant.widgetKey,
      },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
