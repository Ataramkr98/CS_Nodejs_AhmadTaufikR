import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ConversationChannel,
  ConversationStatus,
  MessageRole,
  MessageStatus,
} from '@prisma/client';
import { ChatRequest } from '../common/contracts';
import { PrismaService } from '../database/prisma.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ProviderService } from '../providers/provider.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
    private readonly providers: ProviderService,
    private readonly moduleRef: ModuleRef,
    private readonly realtime: RealtimeGateway,
  ) {}

  async list(
    tenantId: string,
    input: {
      query?: string;
      status?: ConversationStatus;
      channel?: ConversationChannel;
      limit?: number;
      cursor?: string;
    },
  ) {
    const limit = input.limit ?? 25;
    const where = {
      tenantId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.query
        ? {
            OR: [
              {
                subject: {
                  contains: input.query,
                  mode: 'insensitive' as const,
                },
              },
              {
                customer: {
                  name: { contains: input.query, mode: 'insensitive' as const },
                },
              },
              {
                customer: {
                  email: {
                    contains: input.query,
                    mode: 'insensitive' as const,
                  },
                },
              },
            ],
          }
        : {}),
    };
    const data = await this.prisma.withTenant(tenantId, (tx) =>
      tx.conversation.findMany({
        where,
        include: {
          customer: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      }),
    );
    const next = data.length > limit ? data.pop() : undefined;
    return { data, nextCursor: next?.id ?? null };
  }

  async get(tenantId: string, id: string) {
    const conversation = await this.prisma.withTenant(tenantId, (tx) =>
      tx.conversation.findFirst({
        where: { id, tenantId },
        include: {
          customer: true,
          messages: {
            include: { citations: true },
            orderBy: { createdAt: 'asc' },
          },
          events: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return conversation;
  }

  /**
   * Visitor-facing transcript used by the embeddable widget. Operators use
   * `get`; this projection keeps customer PII minimal and never leaks the
   * internal event log or citation scores.
   */
  async transcript(tenantId: string, conversationId: string) {
    const conversation = await this.get(tenantId, conversationId);
    return {
      status: conversation.status,
      messages: conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(message.role === MessageRole.ASSISTANT &&
        message.confidence !== null
          ? { confidence: message.confidence }
          : {}),
      })),
    };
  }

  async createPublicConversation(
    tenantId: string,
    input: { name?: string; email?: string; subject?: string },
  ) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const customer = input.email
        ? await tx.customer.upsert({
            where: {
              tenantId_email: { tenantId, email: input.email.toLowerCase() },
            },
            update: { name: input.name ?? undefined },
            create: {
              tenantId,
              name: input.name,
              email: input.email.toLowerCase(),
            },
          })
        : await tx.customer.create({ data: { tenantId, name: input.name } });
      const conversation = await tx.conversation.create({
        data: {
          tenantId,
          customerId: customer.id,
          channel: ConversationChannel.WEB,
          subject: input.subject,
        },
        include: { customer: true },
      });
      await tx.conversationEvent.create({
        data: {
          conversationId: conversation.id,
          type: 'conversation.created',
          data: { channel: 'WEB' },
        },
      });
      return { conversation, customer };
    });
  }

  async addPublicMessage(
    tenantId: string,
    conversationId: string,
    customerId: string,
    content: string,
  ) {
    const conversation = await this.get(tenantId, conversationId);
    if (conversation.customerId !== customerId)
      throw new NotFoundException(
        'Conversation visitor session does not match.',
      );
    return this.addMessage(tenantId, conversationId, {
      role: MessageRole.CUSTOMER,
      content,
    });
  }

  async addAgentMessage(
    tenantId: string,
    conversationId: string,
    authorUserId: string,
    content: string,
  ) {
    return this.addMessage(tenantId, conversationId, {
      role: MessageRole.AGENT,
      content,
      authorUserId,
      forceHuman: true,
    });
  }

  async takeover(tenantId: string, conversationId: string, userId: string) {
    return this.setStatus(
      tenantId,
      conversationId,
      ConversationStatus.HUMAN,
      'conversation.taken-over',
      { userId },
    );
  }

  async handoff(tenantId: string, conversationId: string, userId: string) {
    return this.setStatus(
      tenantId,
      conversationId,
      ConversationStatus.HANDOFF,
      'conversation.handed-off',
      { userId },
    );
  }

  async resolve(tenantId: string, conversationId: string, userId: string) {
    return this.setStatus(
      tenantId,
      conversationId,
      ConversationStatus.RESOLVED,
      'conversation.resolved',
      { userId },
    );
  }

  async processReply(
    tenantId: string,
    conversationId: string,
    customerMessageId: string,
  ): Promise<void> {
    try {
      const conversation = await this.get(tenantId, conversationId);
      if (conversation.status !== ConversationStatus.BOT) return;
      const customerMessage = conversation.messages.find(
        (message) =>
          message.id === customerMessageId &&
          message.role === MessageRole.CUSTOMER,
      );
      if (!customerMessage) return;
      const settings = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
      );
      if (!settings.autoReplyEnabled) return;
      const hits = await this.knowledge.search(
        tenantId,
        customerMessage.content,
      );
      const prompt: ChatRequest = {
        tenantId,
        language: settings.language,
        context: hits,
        messages: conversation.messages.slice(-12).map((message) => ({
          role:
            message.role === MessageRole.ASSISTANT
              ? 'assistant'
              : message.role === MessageRole.SYSTEM
                ? 'system'
                : 'user',
          content: message.content,
        })),
      };
      const startedAt = Date.now();
      const result = await this.providers.generate(prompt);
      const assistant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.message.create({
          data: {
            tenantId,
            conversationId,
            role: MessageRole.ASSISTANT,
            status: MessageStatus.STREAMING,
            content: '',
            provider: result.provider,
            model: result.model,
            confidence: hits[0]?.score ?? 0,
          },
        }),
      );
      this.realtime.emitConversation(
        tenantId,
        conversationId,
        'assistant.stream.started',
        {
          conversationId,
          messageId: assistant.id,
          provider: result.provider,
          model: result.model,
          citations: hits.map(({ chunkId, sourceId, sourceTitle, score }) => ({
            chunkId,
            sourceId,
            sourceTitle,
            score,
          })),
        },
      );
      let content = '';
      // Failures mid-stream are handled here rather than by the outer catch: the
      // placeholder assistant message already exists at that point, so it has to
      // be finalised or the transcript would keep an empty STREAMING bubble.
      try {
        for await (const delta of result.stream) {
          content += delta;
          this.realtime.emitConversation(
            tenantId,
            conversationId,
            'assistant.stream.delta',
            { conversationId, messageId: assistant.id, delta },
          );
        }
      } catch (streamError) {
        await this.prisma.withTenant(tenantId, (tx) =>
          tx.message.update({
            where: { id: assistant.id },
            data: {
              content:
                content ||
                'The assistant could not complete this reply. A teammate will follow up.',
              status: MessageStatus.FAILED,
              latencyMs: Date.now() - startedAt,
            },
          }),
        );
        this.realtime.emitConversation(
          tenantId,
          conversationId,
          'assistant.stream.failed',
          {
            conversationId,
            messageId: assistant.id,
            detail:
              streamError instanceof Error ? streamError.message : 'unknown',
          },
        );
        await this.prisma.withTenant(tenantId, (tx) =>
          tx.conversation.update({
            where: { id: conversationId },
            data: { status: ConversationStatus.FAILED },
          }),
        );
        return;
      }
      const confidence = hits[0]?.score ?? 0;
      const shouldEscalate =
        confidence < settings.escalationThreshold ||
        /belum menemukan informasi|tidak cukup/i.test(content);
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.message.update({
          where: { id: assistant.id },
          data: {
            content,
            status: MessageStatus.DELIVERED,
            confidence,
            tokensIn: estimateTokens(
              prompt.messages.map((message) => message.content).join(' '),
            ),
            tokensOut: estimateTokens(content),
            latencyMs: Date.now() - startedAt,
          },
        });
        if (hits.length)
          await tx.messageCitation.createMany({
            data: hits.map((hit) => ({
              messageId: assistant.id,
              sourceId: hit.sourceId,
              chunkId: hit.chunkId,
              score: hit.score,
            })),
          });
        await tx.llmUsage.create({
          data: {
            tenantId,
            provider: result.provider,
            model: result.model,
            requestType: 'chat',
            tokensIn: estimateTokens(
              prompt.messages.map((message) => message.content).join(' '),
            ),
            tokensOut: estimateTokens(content),
            latencyMs: Date.now() - startedAt,
            outcome: shouldEscalate ? 'escalated' : 'completed',
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: new Date(),
            ...(shouldEscalate ? { status: ConversationStatus.HANDOFF } : {}),
          },
        });
        if (shouldEscalate)
          await tx.conversationEvent.create({
            data: {
              conversationId,
              type: 'conversation.escalated',
              data: { confidence, threshold: settings.escalationThreshold },
            },
          });
      });
      this.realtime.emitConversation(
        tenantId,
        conversationId,
        'assistant.stream.completed',
        { conversationId, messageId: assistant.id, content, confidence },
      );
      if (shouldEscalate)
        this.realtime.emitConversation(
          tenantId,
          conversationId,
          'conversation.escalated',
          { conversationId, confidence, status: ConversationStatus.HANDOFF },
        );
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : 'Unknown AI generation failure.';
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.conversation.update({
          where: { id: conversationId },
          data: { status: ConversationStatus.FAILED },
        }),
      );
      this.realtime.emitConversation(
        tenantId,
        conversationId,
        'assistant.stream.failed',
        { conversationId, detail },
      );
    }
  }

  private async addMessage(
    tenantId: string,
    conversationId: string,
    input: {
      role: MessageRole;
      content: string;
      authorUserId?: string;
      forceHuman?: boolean;
    },
  ) {
    await this.get(tenantId, conversationId);
    const message = await this.prisma.withTenant(tenantId, async (tx) => {
      const created = await tx.message.create({
        data: {
          tenantId,
          conversationId,
          role: input.role,
          content: input.content,
          authorUserId: input.authorUserId,
          status: MessageStatus.DELIVERED,
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          ...(input.forceHuman ? { status: ConversationStatus.HUMAN } : {}),
        },
      });
      return created;
    });
    this.realtime.emitConversation(
      tenantId,
      conversationId,
      'conversation.message.created',
      { conversationId, message },
    );
    if (input.role === MessageRole.CUSTOMER)
      await this.jobsService.enqueueReply(tenantId, conversationId, message.id);
    return { message, generationQueued: input.role === MessageRole.CUSTOMER };
  }

  private async setStatus(
    tenantId: string,
    conversationId: string,
    status: ConversationStatus,
    type: string,
    data: Record<string, string>,
  ) {
    await this.get(tenantId, conversationId);
    const conversation = await this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.conversation.update({
        where: { id: conversationId },
        data: { status },
      });
      await tx.conversationEvent.create({
        data: { conversationId, type, data },
      });
      return updated;
    });
    this.realtime.emitConversation(
      tenantId,
      conversationId,
      'conversation.status.changed',
      { conversationId, status },
    );
    return conversation;
  }

  private get jobsService(): {
    enqueueReply(
      tenantId: string,
      conversationId: string,
      customerMessageId: string,
    ): Promise<void>;
  } {
    return this.moduleRef.get('JobsService', { strict: false });
  }
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}
