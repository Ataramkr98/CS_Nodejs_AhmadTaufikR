import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import { ConversationService } from '../conversations/conversation.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private queue?: Queue;
  private worker?: Worker;
  private knowledge?: KnowledgeService;
  private conversations?: ConversationService;

  constructor(
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.knowledge = this.moduleRef.get(KnowledgeService, { strict: false });
    this.conversations = this.moduleRef.get(ConversationService, {
      strict: false,
    });
    if (this.config.get('QUEUE_ENABLED') !== 'true') {
      this.logger.log(
        'BullMQ disabled; jobs execute in-process for local development.',
      );
      return;
    }
    const redisUrl = new URL(
      this.config.get('REDIS_URL', 'redis://redis:6379'),
    );
    const connection = {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      ...(redisUrl.username
        ? { username: decodeURIComponent(redisUrl.username) }
        : {}),
      ...(redisUrl.password
        ? { password: decodeURIComponent(redisUrl.password) }
        : {}),
      maxRetriesPerRequest: null,
    };
    this.queue = new Queue('csp-jobs', { connection });
    this.worker = new Worker(
      'csp-jobs',
      async (job) => this.run(job.name, job.data),
      { connection },
    );
  }

  async enqueueIngestion(tenantId: string, sourceId: string): Promise<void> {
    await this.enqueue('knowledge-ingest', { tenantId, sourceId });
  }

  async enqueueReply(
    tenantId: string,
    conversationId: string,
    customerMessageId: string,
  ): Promise<void> {
    await this.enqueue('reply-generate', {
      tenantId,
      conversationId,
      customerMessageId,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  private async enqueue(
    name: string,
    data: {
      tenantId: string;
      sourceId?: string;
      conversationId?: string;
      customerMessageId?: string;
    },
  ): Promise<void> {
    if (this.queue) {
      await this.queue.add(name, data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 750 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      return;
    }
    queueMicrotask(
      () =>
        void this.run(name, data).catch((error) =>
          this.logger.error(
            `Local job ${name} failed`,
            error instanceof Error ? error.stack : undefined,
          ),
        ),
    );
  }

  private async run(
    name: string,
    data: {
      tenantId: string;
      sourceId?: string;
      conversationId?: string;
      customerMessageId?: string;
    },
  ): Promise<void> {
    if (name === 'knowledge-ingest' && data.sourceId)
      return this.knowledge!.processSource(data.tenantId, data.sourceId);
    if (
      name === 'reply-generate' &&
      data.conversationId &&
      data.customerMessageId
    )
      return this.conversations!.processReply(
        data.tenantId,
        data.conversationId,
        data.customerMessageId,
      );
    throw new Error(`Unknown job ${name}`);
  }
}
