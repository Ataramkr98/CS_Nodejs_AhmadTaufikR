import { ModuleRef } from '@nestjs/core';
import { ConversationStatus, MessageRole, MessageStatus } from '@prisma/client';
import { ConversationService } from './conversation.service';
import { PrismaService } from '../database/prisma.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ProviderService } from '../providers/provider.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('24/7 automatic replies', () => {
  const customer = {
    id: 'customer-message',
    role: MessageRole.CUSTOMER,
    status: MessageStatus.DELIVERED,
    content: 'What carriers do you use?',
  };
  const conversation = {
    id: 'conversation',
    customerId: 'visitor',
    status: ConversationStatus.BOT,
    messages: [customer],
  };
  const settings = {
    autoReplyEnabled: true,
    autoReplyModel: 'preferred-model',
    language: 'en',
    brandVoice: 'Warm and concise.',
    businessHours: '09:00-17:00',
    timezone: 'UTC',
    escalationThreshold: 0.65,
    streamingEnabled: true,
    citationsEnabled: true,
  };
  let service: ConversationService;
  let tx: ReturnType<typeof transaction>;
  let generate: jest.Mock;
  let enqueueReply: jest.Mock;
  let emitConversation: jest.Mock;

  function transaction() {
    return {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(conversation),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({
          ...conversation,
          status: ConversationStatus.BOT,
        }),
      },
      tenantSettings: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(settings),
      },
      message: {
        findFirst: jest.fn().mockResolvedValue(customer),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue(customer),
        update: jest
          .fn()
          .mockImplementation(({ where, data }) =>
            Promise.resolve({ id: where.id, ...data }),
          ),
      },
      messageCitation: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      llmUsage: { create: jest.fn().mockResolvedValue({}) },
      conversationEvent: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  beforeEach(() => {
    tx = transaction();
    generate = jest.fn().mockImplementation(async () => ({
      provider: 'autoapp',
      model: 'preferred-model',
      stream: (async function* () {
        yield 'We use JNE and J&T.';
      })(),
    }));
    enqueueReply = jest.fn().mockResolvedValue(undefined);
    emitConversation = jest.fn();
    service = new ConversationService(
      {
        withTenant: jest.fn(
          (_tenant, callback: (value: typeof tx) => unknown) => callback(tx),
        ),
      } as unknown as PrismaService,
      {
        search: jest.fn().mockResolvedValue([
          {
            chunkId: 'chunk',
            sourceId: 'source',
            sourceTitle: 'Shipping',
            content: 'JNE and J&T',
            score: 0.9,
          },
        ]),
      } as unknown as KnowledgeService,
      { generate } as unknown as ProviderService,
      { get: () => ({ enqueueReply }) } as unknown as ModuleRef,
      { emitConversation, emitTenant: jest.fn() } as unknown as RealtimeGateway,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('answers outside business hours with the selected model, voice and actual usage', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-18T02:00:00Z') });
    await service.processReply('tenant', 'conversation', customer.id);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredModel: 'preferred-model',
        brandVoice: settings.brandVoice,
      }),
    );
    expect(tx.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MessageStatus.DELIVERED,
          content: 'We use JNE and J&T.',
        }),
      }),
    );
    expect(tx.llmUsage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'completed',
          model: 'preferred-model',
        }),
      }),
    );
    expect(emitConversation).toHaveBeenCalledWith(
      'tenant',
      'conversation',
      'assistant.stream.completed',
      expect.any(Object),
    );
  });

  it.each([
    ConversationStatus.HUMAN,
    ConversationStatus.HANDOFF,
    ConversationStatus.RESOLVED,
  ])('leaves %s conversations under human control', async (status) => {
    tx.conversation.findFirst.mockResolvedValue({ ...conversation, status });
    await service.processReply('tenant', 'conversation', customer.id);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not contact the provider while auto-replies are paused', async () => {
    tx.tenantSettings.findUniqueOrThrow.mockResolvedValue({
      ...settings,
      autoReplyEnabled: false,
    });
    await service.processReply('tenant', 'conversation', customer.id);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not regenerate a turn already claimed by another instance', async () => {
    tx.message.createMany.mockResolvedValue({ count: 0 });
    await service.processReply('tenant', 'conversation', customer.id);
    expect(generate).not.toHaveBeenCalled();
  });

  it('skips an older customer turn when a newer message has arrived', async () => {
    tx.message.findFirst.mockResolvedValue({
      ...customer,
      id: 'newer-message',
    });
    await service.processReply('tenant', 'conversation', customer.id);
    expect(generate).not.toHaveBeenCalled();
  });

  it('discards a generated reply if an operator takes over before delivery', async () => {
    tx.conversation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await service.processReply('tenant', 'conversation', customer.id);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(emitConversation).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MessageStatus.DELIVERED }),
      }),
    );
    expect(tx.llmUsage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'cancelled' }),
      }),
    );
  });

  it('discards a reply if the workspace pauses the agent during generation', async () => {
    tx.tenantSettings.findUniqueOrThrow
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce({ ...settings, autoReplyEnabled: false });
    await service.processReply('tenant', 'conversation', customer.id);
    expect(emitConversation).not.toHaveBeenCalled();
  });

  it('keeps failed provider output out of the visitor transcript', async () => {
    generate.mockRejectedValue(new Error('Provider unavailable'));
    await service.processReply('tenant', 'conversation', customer.id);
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: `auto-${customer.id}` },
      data: { status: MessageStatus.FAILED, content: '' },
    });
    expect(tx.conversation.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: ConversationStatus.FAILED } }),
    );
  });

  it('resumes the unanswered customer message when Back to AI is clicked', async () => {
    await service.handoff('tenant', 'conversation', 'operator');
    expect(enqueueReply).toHaveBeenCalledWith(
      'tenant',
      'conversation',
      customer.id,
    );
  });

  it('reopens a resolved conversation and queues an automatic answer for a new question', async () => {
    tx.conversation.findFirst.mockResolvedValue({
      ...conversation,
      status: ConversationStatus.RESOLVED,
    });
    tx.conversation.update.mockResolvedValueOnce({
      ...conversation,
      status: ConversationStatus.RESOLVED,
    });
    await expect(
      service.addPublicMessage(
        'tenant',
        'conversation',
        'visitor',
        customer.content,
      ),
    ).resolves.toMatchObject({ generationQueued: true });
    expect(tx.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ConversationStatus.BOT }),
      }),
    );
    expect(enqueueReply).toHaveBeenCalledWith(
      'tenant',
      'conversation',
      customer.id,
    );
  });
});
