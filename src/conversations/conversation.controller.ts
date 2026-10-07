import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ConversationChannel,
  ConversationStatus,
  UserRole,
} from '@prisma/client';
import { z } from 'zod';
import { OperatorGuard, requireRole } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { paginationSchema, parseInput } from '../common/validation';
import { ConversationService } from './conversation.service';

const listSchema = paginationSchema.extend({
  query: z.string().trim().max(120).optional(),
  status: z.nativeEnum(ConversationStatus).optional(),
  channel: z.nativeEnum(ConversationChannel).optional(),
});
const messageSchema = z.object({ content: z.string().trim().min(1).max(8000) });

@Controller('api')
@UseGuards(OperatorGuard)
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Get('conversations')
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.conversations.list(
      request.user!.tenantId,
      parseInput(listSchema, query),
    );
  }

  @Get('chat-logs')
  logs(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.conversations.list(
      request.user!.tenantId,
      parseInput(listSchema, query),
    );
  }

  @Get('conversations/:id')
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.conversations.get(request.user!.tenantId, id);
  }

  @Post('conversations/:id/messages')
  sendAgentMessage(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT);
    return this.conversations.addAgentMessage(
      request.user!.tenantId,
      id,
      request.user!.sub,
      parseInput(messageSchema, body).content,
    );
  }

  @Post('conversations/:id/takeover')
  takeover(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT);
    return this.conversations.takeover(
      request.user!.tenantId,
      id,
      request.user!.sub,
    );
  }

  @Post('conversations/:id/handoff')
  handoff(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT);
    return this.conversations.handoff(
      request.user!.tenantId,
      id,
      request.user!.sub,
    );
  }

  @Post('conversations/:id/resolve')
  resolve(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT);
    return this.conversations.resolve(
      request.user!.tenantId,
      id,
      request.user!.sub,
    );
  }
}
