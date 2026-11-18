import { ModuleRef } from '@nestjs/core';
import {
  ConversationStatus,
  MessageRole,
  MessageStatus,
  UserRole,
} from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { ConversationController } from './conversation.controller';
import { PrismaService } from '../database/prisma.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ProviderService } from '../providers/provider.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuthenticatedRequest } from '../common/security';

describe('Operator AI drafts', () => {
  const conversation = {
    id: 'conversation-1',
    status: ConversationStatus.HUMAN,
    messages: [
      {
        id: 'customer-1',
        role: MessageRole.CUSTOMER,
        status: MessageStatus.DELIVERED,
        content: 'When will it arrive?',
      },
    ],
  };
  let service: ConversationService;
  let tx: {
    conversation: { findFirst: jest.Mock; update: jest.Mock };
    tenantSettings: { findUniqueOrThrow: jest.Mock };
    llmUsage: { create: jest.Mock };
    message: { create: jest.Mock };
    conversationEvent: { create: jest.Mock };
  };
  let generate: jest.Mock;
  let search: jest.Mock;
  let withTenant: jest.Mock;

  beforeEach(() => {
    tx = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(conversation),
        update: jest.fn().mockResolvedValue({
          id: conversation.id,
          status: ConversationStatus.BOT,
        }),
      },
      tenantSettings: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          language: 'en',
          autoReplyEnabled: false,
          brandVoice: 'Warm and concise.',
        }),
      },
      llmUsage: { create: jest.fn().mockResolvedValue({}) },
      message: { create: jest.fn() },
      conversationEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    withTenant = jest.fn((_id, callback: (value: unknown) => unknown) =>
      callback(tx),
    );
    generate = jest.fn().mockResolvedValue({
      provider: 'autoapp',
      model: 'fallback',
      stream: (async function* () {
        yield 'A draft ';
        yield 'reply.';
      })(),
    });
    search = jest
      .fn()
      .mockResolvedValue([
        { sourceTitle: 'Shipping', content: 'Two working days', score: 0.9 },
      ]);
    service = new ConversationService(
      { withTenant } as unknown as PrismaService,
      { search } as unknown as KnowledgeService,
      { generate } as unknown as ProviderService,
      {} as ModuleRef,
      { emitConversation: jest.fn() } as unknown as RealtimeGateway,
    );
  });

  it('returns an editable suggestion without sending a message or taking over', async () => {
    await expect(
      service.draftReply('tenant-1', conversation.id),
    ).resolves.toEqual({
      content: 'A draft reply.',
      provider: 'autoapp',
      model: 'fallback',
    });
    expect(search).toHaveBeenCalledWith('tenant-1', 'When will it arrive?');
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', language: 'en' }),
    );
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.conversation.update).not.toHaveBeenCalled();
    expect(tx.llmUsage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestType: 'draft',
          provider: 'autoapp',
          model: 'fallback',
        }),
      }),
    );
    expect(withTenant.mock.calls.every(([id]) => id === 'tenant-1')).toBe(true);
  });

  it('rejects a conversation outside the operator tenant before contacting AI', async () => {
    tx.conversation.findFirst.mockResolvedValue(null);
    await expect(
      service.draftReply('tenant-1', 'foreign-conversation'),
    ).rejects.toThrow('Conversation not found');
    expect(generate).not.toHaveBeenCalled();
  });

  it('includes operator context and the previous draft without treating operator replies as customer messages', async () => {
    tx.conversation.findFirst.mockResolvedValue({
      ...conversation,
      messages: [
        ...conversation.messages,
        {
          role: MessageRole.AGENT,
          status: MessageStatus.DELIVERED,
          content: 'We use JNE and J&T.',
        },
        {
          role: MessageRole.CUSTOMER,
          status: MessageStatus.DELIVERED,
          content: 'Bisa kirim ke Papua dengan intermediary?',
        },
        {
          role: MessageRole.AGENT,
          status: MessageStatus.DELIVERED,
          content: 'Our team will follow up.',
        },
        {
          role: MessageRole.SYSTEM,
          status: MessageStatus.DELIVERED,
          content: 'Internal system event',
        },
        {
          role: MessageRole.ASSISTANT,
          status: MessageStatus.FAILED,
          content: 'Failed generation',
        },
      ],
    });
    await service.draftReply('tenant-1', conversation.id, {
      previousDraft: 'Maaf, saya tidak memiliki informasi.',
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'operator-draft',
        latestCustomerMessage: 'Bisa kirim ke Papua dengan intermediary?',
        brandVoice: 'Warm and concise.',
        previousDraft: 'Maaf, saya tidak memiliki informasi.',
        messages: [
          { role: 'user', content: 'When will it arrive?' },
          { role: 'assistant', content: 'We use JNE and J&T.' },
          { role: 'user', content: 'Bisa kirim ke Papua dengan intermediary?' },
          { role: 'assistant', content: 'Our team will follow up.' },
        ],
      }),
    );
    expect(search).toHaveBeenCalledWith(
      'tenant-1',
      'Bisa kirim ke Papua dengan intermediary?',
    );
  });

  it('rejects conversations with no customer message', async () => {
    tx.conversation.findFirst.mockResolvedValue({
      ...conversation,
      messages: [],
    });
    await expect(
      service.draftReply('tenant-1', conversation.id),
    ).rejects.toThrow('no customer message');
    expect(generate).not.toHaveBeenCalled();
  });

  it('surfaces provider failure without creating or sending a draft', async () => {
    generate.mockRejectedValue(
      new ServiceUnavailableException('AI gateway subscription has expired.'),
    );
    await expect(
      service.draftReply('tenant-1', conversation.id),
    ).rejects.toThrow('subscription has expired');
    expect(tx.llmUsage.create).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it('returns Back to AI conversations to BOT so automatic replies can run again', async () => {
    await service.handoff('tenant-1', conversation.id, 'operator-1');
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: conversation.id },
      data: { status: ConversationStatus.BOT },
    });
  });

  it('rejects viewer roles for the draft endpoint', () => {
    const controller = new ConversationController(service);
    const request = {
      user: { tenantId: 'tenant-1', role: UserRole.VIEWER },
    } as AuthenticatedRequest;
    expect(() => controller.draftReply(request, conversation.id)).toThrow(
      'Your role cannot perform this action.',
    );
    expect(generate).not.toHaveBeenCalled();
  });
});
