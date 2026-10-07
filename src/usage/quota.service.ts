import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class QuotaService implements OnModuleDestroy {
  private readonly logger = new Logger(QuotaService.name);
  private redis?: IORedis;
  private redisDisabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async reserve(
    tenantId: string,
    provider: string,
    model: string,
    dailyLimit?: number,
  ): Promise<boolean> {
    if (!dailyLimit) return true;
    const redis = this.getRedis();
    if (redis) {
      try {
        const key = `csp:quota:${tenantId}:${provider}:${model}:${dayKey()}`;
        const used = await redis.incr(key);
        if (used === 1) await redis.expire(key, secondsUntilTomorrow());
        return used <= dailyLimit;
      } catch (error) {
        this.redisDisabled = true;
        this.logger.warn(
          `Redis quota counter unavailable; using database fallback: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const used = await this.prisma.withTenant(tenantId, (tx) =>
      tx.llmUsage.count({
        where: { tenantId, provider, model, createdAt: { gte: start } },
      }),
    );
    return used < dailyLimit;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }

  private getRedis(): IORedis | undefined {
    if (this.redisDisabled || this.config.get('QUEUE_ENABLED') !== 'true')
      return undefined;
    if (!this.redis) {
      this.redis = new IORedis(
        this.config.get('REDIS_URL', 'redis://redis:6379'),
        { lazyConnect: false, maxRetriesPerRequest: 1 },
      );
      this.redis.on('error', () => undefined);
    }
    return this.redis;
  }
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilTomorrow(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
}
