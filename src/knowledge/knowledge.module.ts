import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProviderModule } from '../providers/provider.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [AuthModule, ProviderModule, RealtimeModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
