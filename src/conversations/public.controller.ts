import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { TokenService } from '../auth/token.service';
import { VisitorGuard } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { parseInput } from '../common/validation';
import { PrismaService } from '../database/prisma.service';
import { ConversationService } from './conversation.service';

const sessionSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().email().optional(),
  subject: z.string().trim().max(240).optional(),
});
const messageSchema = z.object({ content: z.string().trim().min(1).max(8000) });

@Controller('api/public')
export class PublicConversationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
    private readonly tokens: TokenService,
  ) {}

  @Get('widgets/:widgetKey')
  async widget(
    @Param('widgetKey') widgetKey: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const tenant = await this.prisma.withWidgetKey(widgetKey, (tx) =>
      tx.tenant.findUnique({ where: { widgetKey } }),
    );
    if (!tenant) throw new NotFoundException('Widget not found.');
    const settings = await this.prisma.withTenant(tenant.id, (tx) =>
      tx.tenantSettings.findUnique({ where: { tenantId: tenant.id } }),
    );
    const origin = request.headers.origin;
    if (
      tenant.allowedOrigins.length &&
      (!origin || !tenant.allowedOrigins.includes(origin))
    )
      throw new ForbiddenException(
        'This widget is not allowed for the requesting origin.',
      );
    return {
      widgetKey: tenant.widgetKey,
      tenantName: tenant.name,
      language: settings?.language ?? 'id',
      businessHours: settings?.businessHours,
      autoReplyEnabled: settings?.autoReplyEnabled ?? false,
    };
  }

  @Post('widgets/:widgetKey/sessions')
  async createSession(
    @Param('widgetKey') widgetKey: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const tenant = await this.prisma.withWidgetKey(widgetKey, (tx) =>
      tx.tenant.findUnique({ where: { widgetKey } }),
    );
    if (!tenant) throw new NotFoundException('Widget not found.');
    const origin = request.headers.origin;
    if (
      tenant.allowedOrigins.length &&
      (!origin || !tenant.allowedOrigins.includes(origin))
    )
      throw new ForbiddenException(
        'This widget is not allowed for the requesting origin.',
      );
    const created = await this.conversations.createPublicConversation(
      tenant.id,
      parseInput(sessionSchema, body),
    );
    const visitorToken = await this.tokens.issueVisitor({
      customerId: created.customer.id,
      tenantId: tenant.id,
      conversationId: created.conversation.id,
    });
    return { conversation: created.conversation, visitorToken };
  }

  @Get('conversations/:id/messages')
  @UseGuards(VisitorGuard)
  transcript(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    this.assertOwnsConversation(request, id);
    return this.conversations.transcript(
      request.visitor!.tenantId,
      request.visitor!.conversationId,
    );
  }

  @Post('conversations/:id/messages')
  @UseGuards(VisitorGuard)
  send(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertOwnsConversation(request, id);
    return this.conversations.addPublicMessage(
      request.visitor!.tenantId,
      id,
      request.visitor!.sub,
      parseInput(messageSchema, body).content,
    );
  }

  /** A visitor token is scoped to exactly one conversation — nothing else. */
  private assertOwnsConversation(
    request: AuthenticatedRequest,
    id: string,
  ): void {
    if (request.visitor!.conversationId !== id) {
      throw new ForbiddenException(
        'Visitor token is not valid for this conversation.',
      );
    }
  }
}
