import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { ConversationModule } from './conversations/conversation.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { MetricsModule } from './metrics/metrics.module';
import { ProviderModule } from './providers/provider.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TenantModule } from './tenants/tenant.module';

// Rate limit defaults to 120 requests per minute per IP; a shared NAT gateway
// or an office network needs a higher ceiling, so both are configurable.
const THROTTLE_TTL = Number(process.env.THROTTLE_TTL ?? 60_000);
const THROTTLE_LIMIT = Number(process.env.THROTTLE_LIMIT ?? 120);

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      { name: 'default', ttl: THROTTLE_TTL, limit: THROTTLE_LIMIT },
    ]),
    DatabaseModule,
    AuthModule,
    RealtimeModule,
    JobsModule,
    ProviderModule,
    TenantModule,
    KnowledgeModule,
    ConversationModule,
    MetricsModule,
    CapabilitiesModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
