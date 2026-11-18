import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { ProviderService, tokenUsage } from '../providers/provider.service';
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
      messages: conversation.messages
        .filter(
          (message) =>
            message.status === MessageStatus.DELIVERED ||
            message.status === MessageStatus.SENT,
        )
        .map((message) => ({
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

  /** Generate an operator suggestion without sending it or taking over the thread. */
  async draftReply(
    tenantId: string,
    conversationId: string,
    input: { previousDraft?: string } = {},
  ) {
    const conversation = await this.get(tenantId, conversationId);
    const lastCustomer = conversation.messages.findLastIndex(
      (message) =>
        message.role === MessageRole.CUSTOMER && message.content.trim(),
    );
    if (lastCustomer < 0) {
      throw new BadRequestException(
        'There is no customer message to draft a reply to.',
      );
    }
    const settings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
    );
    const context = await this.knowledge.search(
      tenantId,
      conversation.messages[lastCustomer].content,
    );
    const prompt: ChatRequest = {
      tenantId,
      language: settings.language,
      mode: 'operator-draft',
      brandVoice: settings.brandVoice,
      previousDraft: input.previousDraft,
      latestCustomerMessage: conversation.messages[lastCustomer].content,
      context,
      messages: conversation.messages
        .filter(
          (message) =>
            message.content.trim() &&
            message.status !== MessageStatus.FAILED &&
            message.role !== MessageRole.SYSTEM,
        )
        .slice(-12)
        .map((message) => ({
          role:
            message.role === MessageRole.ASSISTANT ||
            message.role === MessageRole.AGENT
              ? 'assistant'
              : 'user',
          content: message.content,
        })),
    };
    const startedAt = Date.now();
    const result = await this.providers.generate(prompt);
    let content = '';
    for await (const delta of result.stream) content += delta;
    if (!content.trim()) {
      throw new ServiceUnavailableException(
        'The AI provider did not produce a reply. Try another provider.',
      );
    }
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.llmUsage.create({
        data: {
          tenantId,
          provider: result.provider,
          model: result.model,
          requestType: 'draft',
          ...tokenUsage(result, prompt, content),
          latencyMs: Date.now() - startedAt,
          outcome: 'completed',
        },
      }),
    );
    return { content, provider: result.provider, model: result.model };
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
    const updated = await this.setStatus(
      tenantId,
      conversationId,
      ConversationStatus.BOT,
      'conversation.returned-to-bot',
      { userId },
    );
    const settings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
    );
    if (settings.autoReplyEnabled) {
      const conversation = await this.get(tenantId, conversationId);
      const latest = conversation.messages.findLast(
        (message) =>
          (message.status === MessageStatus.DELIVERED ||
            message.status === MessageStatus.SENT) &&
          message.role !== MessageRole.SYSTEM,
      );
      if (latest?.role === MessageRole.CUSTOMER) {
        await this.jobsService.enqueueReply(
          tenantId,
          conversationId,
          latest.id,
        );
        return this.get(tenantId, conversationId);
      }
    }
    return updated;
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
    // The customer message is the durable idempotency key. Queue retries and
    // concurrent instances can claim only one automatic reply for this turn.
    const replyId = `auto-${customerMessageId}`;
    let claimed = false;
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
      claimed = await this.prisma.withTenant(tenantId, async (tx) => {
        // Lock this conversation briefly, without holding a transaction open
        // during the provider call. A takeover or a newer turn wins at delivery.
        const active = await tx.conversation.updateMany({
          where: {
            id: conversationId,
            tenantId,
            status: ConversationStatus.BOT,
          },
          data: { status: ConversationStatus.BOT },
        });
        if (!active.count) return false;
        const latest = await tx.message.findFirst({
          where: {
            tenantId,
            conversationId,
            role: {
              in: [
                MessageRole.CUSTOMER,
                MessageRole.AGENT,
                MessageRole.ASSISTANT,
              ],
            },
            status: { in: [MessageStatus.DELIVERED, MessageStatus.SENT] },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (latest?.id !== customerMessageId) return false;
        await tx.message.deleteMany({
          where: {
            id: replyId,
            tenantId,
            OR: [
              { status: MessageStatus.FAILED },
              {
                status: {
                  in: [MessageStatus.PENDING, MessageStatus.STREAMING],
                },
                updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
              },
            ],
          },
        });
        const created = await tx.message.createMany({
          data: [
            {
              id: replyId,
              tenantId,
              conversationId,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.PENDING,
              content: '',
            },
          ],
          skipDuplicates: true,
        });
        return created.count === 1;
      });
      if (!claimed) return;
      const hits = await this.knowledge.search(
        tenantId,
        customerMessage.content,
      );
      const prompt: ChatRequest = {
        tenantId,
        language: settings.language,
        preferredModel: settings.autoReplyModel,
        brandVoice: settings.brandVoice,
        context: hits,
        messages: conversation.messages
          .filter(
            (message) =>
              message.content.trim() &&
              (message.status === MessageStatus.DELIVERED ||
                message.status === MessageStatus.SENT) &&
              message.role !== MessageRole.SYSTEM,
          )
          .slice(-12)
          .map((message) => ({
            role:
              message.role === MessageRole.ASSISTANT ||
              message.role === MessageRole.AGENT
                ? 'assistant'
                : 'user',
            content: message.content,
          })),
      };
      const startedAt = Date.now();
      const result = await this.providers.generate(prompt);
      const assistant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.message.update({
          where: { id: replyId },
          data: {
            status: MessageStatus.STREAMING,
            provider: result.provider,
            model: result.model,
            confidence: hits[0]?.score ?? 0,
          },
        }),
      );
      this.realtime.emitTenant(tenantId, 'assistant.stream.started', {
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
      });
      let content = '';
      for await (const delta of result.stream) {
        content += delta;
        // Operators may preview the stream. Visitors receive only the
        // committed reply, after a final check for takeover or a paused agent.
        if (settings.streamingEnabled)
          this.realtime.emitTenant(tenantId, 'assistant.stream.delta', {
            conversationId,
            messageId: assistant.id,
            delta,
          });
      }
      if (!content.trim()) {
        throw new ServiceUnavailableException(
          'The AI provider returned an empty reply.',
        );
      }
      const confidence = hits[0]?.score ?? 0;
      const shouldEscalate =
        confidence < settings.escalationThreshold ||
        /belum menemukan informasi|tidak cukup/i.test(content);
      const delivered = await this.prisma.withTenant(tenantId, async (tx) => {
        const active = await tx.conversation.updateMany({
          where: {
            id: conversationId,
            tenantId,
            status: ConversationStatus.BOT,
          },
          data: { status: ConversationStatus.BOT },
        });
        const currentSettings = await tx.tenantSettings.findUniqueOrThrow({
          where: { tenantId },
        });
        const latest = await tx.message.findFirst({
          where: {
            tenantId,
            conversationId,
            role: {
              in: [
                MessageRole.CUSTOMER,
                MessageRole.AGENT,
                MessageRole.ASSISTANT,
              ],
            },
            status: { in: [MessageStatus.DELIVERED, MessageStatus.SENT] },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const canDeliver =
          active.count > 0 &&
          currentSettings.autoReplyEnabled &&
          latest?.id === customerMessageId;
        await tx.llmUsage.create({
          data: {
            tenantId,
            provider: result.provider,
            model: result.model,
            requestType: 'chat',
            ...tokenUsage(result, prompt, content),
            latencyMs: Date.now() - startedAt,
            outcome: canDeliver
              ? shouldEscalate
                ? 'escalated'
                : 'completed'
              : 'cancelled',
          },
        });
        if (!canDeliver) {
          await tx.message.update({
            where: { id: replyId },
            data: { status: MessageStatus.FAILED, content: '' },
          });
          return false;
        }
        await tx.message.update({
          where: { id: assistant.id },
          data: {
            content,
            status: MessageStatus.DELIVERED,
            confidence,
            ...tokenUsage(result, prompt, content),
            latencyMs: Date.now() - startedAt,
          },
        });
        if (hits.length && currentSettings.citationsEnabled)
          await tx.messageCitation.createMany({
            data: hits.map((hit) => ({
              messageId: assistant.id,
              sourceId: hit.sourceId,
              chunkId: hit.chunkId,
              score: hit.score,
            })),
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
        return true;
      });
      if (!delivered) {
        this.realtime.emitTenant(tenantId, 'assistant.stream.cancelled', {
          conversationId,
          messageId: replyId,
        });
        return;
      }
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
      if (!claimed) throw error;
      const detail =
        error instanceof Error
          ? error.message
          : 'Unknown AI generation failure.';
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.message.update({
          where: { id: replyId },
          data: { status: MessageStatus.FAILED, content: '' },
        });
        await tx.conversation.updateMany({
          where: {
            id: conversationId,
            tenantId,
            status: ConversationStatus.BOT,
          },
          data: { status: ConversationStatus.FAILED },
        });
      });
      this.realtime.emitTenant(tenantId, 'assistant.stream.failed', {
        conversationId,
        messageId: replyId,
        detail,
      });
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
    const { message, status } = await this.prisma.withTenant(
      tenantId,
      async (tx) => {
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
        const updated = await tx.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: new Date(),
            ...(input.forceHuman ? { status: ConversationStatus.HUMAN } : {}),
          },
        });
        const reopen =
          input.role === MessageRole.CUSTOMER &&
          updated.status === ConversationStatus.RESOLVED;
        if (reopen)
          await tx.conversation.update({
            where: { id: conversationId },
            data: { status: ConversationStatus.BOT },
          });
        return {
          message: created,
          status: reopen ? ConversationStatus.BOT : updated.status,
        };
      },
    );
    this.realtime.emitConversation(
      tenantId,
      conversationId,
      'conversation.message.created',
      { conversationId, message },
    );
    const settings =
      input.role === MessageRole.CUSTOMER
        ? await this.prisma.withTenant(tenantId, (tx) =>
            tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
          )
        : null;
    const generationQueued =
      input.role === MessageRole.CUSTOMER &&
      Boolean(settings?.autoReplyEnabled) &&
      status === ConversationStatus.BOT;
    if (generationQueued)
      await this.jobsService.enqueueReply(tenantId, conversationId, message.id);
    return { message, generationQueued };
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
