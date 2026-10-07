import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProviderModule } from '../providers/provider.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { PublicConversationController } from './public.controller';

@Module({
  imports: [AuthModule, KnowledgeModule, ProviderModule, RealtimeModule],
  controllers: [ConversationController, PublicConversationController],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
