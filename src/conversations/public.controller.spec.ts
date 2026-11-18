import { PublicConversationController } from './public.controller';
import { PrismaService } from '../database/prisma.service';
import { ConversationService } from './conversation.service';
import { TokenService } from '../auth/token.service';
import type { AuthenticatedRequest } from '../common/security';

describe('Widget origins', () => {
  const origin = 'https://cs.example.com';
  const tenant = {
    id: 'tenant',
    name: 'Demo',
    widgetKey: 'demo-key',
    allowedOrigins: [origin],
  };
  let controller: PublicConversationController;

  beforeEach(() => {
    const tx = {
      tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
      tenantSettings: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ autoReplyEnabled: true, language: 'id' }),
      },
    };
    const scoped = jest.fn((_key, callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );
    controller = new PublicConversationController(
      { withWidgetKey: scoped, withTenant: scoped } as unknown as PrismaService,
      {} as ConversationService,
      {} as TokenService,
    );
  });

  it('accepts the widget page origin when a same-origin GET has no Origin header', async () => {
    const request = {
      headers: { 'x-csp-widget-origin': origin },
    } as unknown as AuthenticatedRequest;
    await expect(controller.widget('demo-key', request)).resolves.toMatchObject(
      { aiAvailability: '24/7' },
    );
  });

  it('rejects an unknown page even when the Origin header is absent', async () => {
    const request = {
      headers: { 'x-csp-widget-origin': 'https://other.example' },
    } as unknown as AuthenticatedRequest;
    await expect(controller.widget('demo-key', request)).rejects.toThrow(
      'not allowed',
    );
  });

  it('does not let a custom header override the browser Origin', async () => {
    const request = {
      headers: {
        origin: 'https://other.example',
        'x-csp-widget-origin': origin,
      },
    } as unknown as AuthenticatedRequest;
    await expect(controller.widget('demo-key', request)).rejects.toThrow(
      'not allowed',
    );
  });

  it('continues to reject requests without either origin header', async () => {
    await expect(
      controller.widget('demo-key', { headers: {} } as AuthenticatedRequest),
    ).rejects.toThrow('not allowed');
  });
});
