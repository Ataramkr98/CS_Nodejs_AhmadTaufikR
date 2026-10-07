import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service';

@WebSocketGateway({ path: '/ws', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly tokens: TokenService) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const supplied =
        client.handshake.auth?.token ??
        client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (typeof supplied !== 'string') throw new Error('No token supplied.');
      try {
        const operator = await this.tokens.verifyOperator(supplied);
        await client.join(`tenant:${operator.tenantId}`);
        client.data.identity = operator;
        return;
      } catch {
        const visitor = await this.tokens.verifyVisitor(supplied);
        // Visitors are scoped to their own conversation room only. Joining the
        // tenant room would let any widget visitor receive the streamed replies
        // and escalation events of every other customer in that tenant.
        await client.join(`conversation:${visitor.conversationId}`);
        client.data.identity = visitor;
      }
    } catch {
      this.logger.warn(`Rejected realtime connection ${client.id}`);
      client.disconnect(true);
    }
  }

  emitConversation(
    tenantId: string,
    conversationId: string,
    event: string,
    payload: unknown,
  ): void {
    this.server
      .to(`tenant:${tenantId}`)
      .to(`conversation:${conversationId}`)
      .emit(event, payload);
  }

  emitTenant(tenantId: string, event: string, payload: unknown): void {
    this.server.to(`tenant:${tenantId}`).emit(event, payload);
  }
}
