import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(tenantId: string) {
    const tenant = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        include: { settings: true },
      }),
    );
    if (!tenant) throw new NotFoundException('Tenant not found.');
    return tenant;
  }

  async updateProfile(tenantId: string, input: Record<string, unknown>) {
    const { name, allowedOrigins, ...settings } = input;
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (typeof name === 'string')
        await tx.tenant.update({ where: { id: tenantId }, data: { name } });
      if (Array.isArray(allowedOrigins))
        await tx.tenant.update({
          where: { id: tenantId },
          data: { allowedOrigins: allowedOrigins as string[] },
        });
      await tx.tenantSettings.update({ where: { tenantId }, data: settings });
      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'tenant.settings.updated',
          entityType: 'TenantSettings',
          entityId: tenantId,
          details: { fields: Object.keys(input) },
        },
      });
      return tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        include: { settings: true },
      });
    });
  }

  async createApiKey(
    tenantId: string,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ) {
    const secret = randomBytes(32).toString('base64url');
    const rawKey = `csp_${secret}`;
    const keyPrefix = rawKey.slice(0, 12);
    const apiKey = await this.prisma.withTenant(tenantId, (tx) =>
      tx.apiKey.create({
        data: {
          tenantId,
          name,
          scopes,
          expiresAt,
          keyPrefix,
          keyHash: this.hash(rawKey),
        },
      }),
    );
    return { ...apiKey, key: rawKey };
  }

  listApiKeys(tenantId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.apiKey.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
      }),
    );
  }

  revokeApiKey(tenantId: string, id: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const result = await tx.apiKey.updateMany({
        where: { id, tenantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!result.count) throw new NotFoundException('API key not found.');
      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'api-key.revoked',
          entityType: 'ApiKey',
          entityId: id,
        },
      });
      return { ok: true };
    });
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
