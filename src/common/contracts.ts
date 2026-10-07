import { UserRole } from '@prisma/client';

export interface AuthenticatedUser {
  sub: string;
  tenantId: string;
  role: UserRole;
  email: string;
  kind: 'operator';
}

export interface VisitorSession {
  sub: string;
  tenantId: string;
  conversationId: string;
  kind: 'visitor';
}

export interface RetrievalHit {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  content: string;
  score: number;
}

export interface ChatRequest {
  tenantId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  context: RetrievalHit[];
  language: string;
}

export interface ChatResult {
  provider: string;
  model: string;
  stream: AsyncIterable<string>;
}

export interface ProviderDescriptor {
  provider: string;
  model: string;
  enabled: boolean;
  priority: number;
  dailyLimit?: number;
  configured: boolean;
  privacy: 'approved' | 'consent-required' | 'disabled-by-default';
}
