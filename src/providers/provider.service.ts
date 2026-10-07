import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderKind } from '@prisma/client';
import {
  ChatRequest,
  ChatResult,
  ProviderDescriptor,
} from '../common/contracts';
import { PrismaService } from '../database/prisma.service';
import { QuotaService } from '../usage/quota.service';
import {
  AI_MODEL_IDS,
  aiGatewayIsConfigured,
  readAiGatewayConfig,
} from '../ai/ai.config';
import { chatStream, ChatMessage } from '../ai/ai-client';

const PROVIDER_CATALOG: Array<
  Omit<ProviderDescriptor, 'enabled' | 'priority' | 'configured'>
> = [
  // Shared OpenAI-compatible gateway. Ordered cheapest/fastest first so the
  // automatic router prefers it when several entries are enabled.
  {
    provider: 'AUTOAPP',
    model: AI_MODEL_IDS.MINIMAX_M3,
    privacy: 'approved',
  },
  {
    provider: 'AUTOAPP',
    model: AI_MODEL_IDS.GLM_53_FLASH,
    privacy: 'approved',
  },
  { provider: 'AUTOAPP', model: AI_MODEL_IDS.KIMI_K3, privacy: 'approved' },
  { provider: 'GROQ', model: 'llama-3.3-70b-versatile', privacy: 'approved' },
  { provider: 'GROQ', model: 'llama-3.1-8b-instant', privacy: 'approved' },
  {
    provider: 'GEMINI',
    model: 'gemini-2.5-flash',
    privacy: 'disabled-by-default',
  },
  {
    provider: 'OPENROUTER',
    model: 'openrouter/free',
    privacy: 'consent-required',
  },
  { provider: 'OLLAMA', model: 'llama3.1:8b', privacy: 'approved' },
  { provider: 'DEMO', model: 'csp-demo-v1', privacy: 'approved' },
];

@Injectable()
export class ProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly quota: QuotaService,
  ) {}

  async list(tenantId: string): Promise<ProviderDescriptor[]> {
    const overrides = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantProviderConfig.findMany({
        where: { tenantId },
        orderBy: { priority: 'asc' },
      }),
    );
    return PROVIDER_CATALOG.map((descriptor) => {
      const match = overrides.find(
        (item) =>
          item.provider === descriptor.provider &&
          item.model === descriptor.model,
      );
      return {
        ...descriptor,
        enabled: match?.enabled ?? false,
        priority: match?.priority ?? 999,
        dailyLimit: match?.dailyLimit ?? undefined,
        configured: this.isConfigured(descriptor.provider),
      };
    });
  }

  async update(
    tenantId: string,
    input: {
      provider: ProviderKind;
      model: string;
      enabled: boolean;
      priority: number;
      dailyLimit?: number;
    },
  ) {
    if (input.provider === ProviderKind.GEMINI && input.enabled) {
      throw new ServiceUnavailableException(
        'Gemini is disabled by default because its free tier does not meet CSP privacy requirements.',
      );
    }
    if (
      input.provider === ProviderKind.DEMO &&
      this.config.get('AI_MODE') !== 'demo'
    ) {
      throw new ServiceUnavailableException(
        'Demo mode is only available when AI_MODE=demo.',
      );
    }
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantProviderConfig.upsert({
        where: {
          tenantId_provider_model: {
            tenantId,
            provider: input.provider,
            model: input.model,
          },
        },
        update: {
          enabled: input.enabled,
          priority: input.priority,
          dailyLimit: input.dailyLimit,
        },
        create: { tenantId, ...input },
      }),
    );
  }

  async generate(request: ChatRequest): Promise<ChatResult> {
    await this.assertWithinBudget(request.tenantId);
    const configured = (await this.list(request.tenantId))
      .filter((candidate) => candidate.enabled && candidate.configured)
      .sort((a, b) => a.priority - b.priority);
    if (!configured.length) {
      throw new ServiceUnavailableException(
        'No approved AI provider is configured. Configure Groq, Ollama, or explicit demo mode.',
      );
    }
    const primary = configured[0];
    return {
      provider: primary.provider.toLowerCase(),
      model: primary.model,
      stream: this.fallbackStream(configured, request),
    };
  }

  /**
   * `autoThrottle` was previously stored but never evaluated, which made the
   * toggle a lie. It now stops generation once the tenant has spent its daily
   * token budget, so the setting on the Budget screen means what it says.
   */
  private async assertWithinBudget(tenantId: string): Promise<void> {
    const settings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantSettings.findUnique({
        where: { tenantId },
        select: { autoThrottle: true, dailyTokenBudget: true },
      }),
    );
    if (!settings?.autoThrottle || settings.dailyTokenBudget <= 0) return;

    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const used = await this.prisma.withTenant(tenantId, (tx) =>
      tx.llmUsage.aggregate({
        where: { tenantId, createdAt: { gte: start } },
        _sum: { tokensIn: true, tokensOut: true },
      }),
    );
    const spent = (used._sum.tokensIn ?? 0) + (used._sum.tokensOut ?? 0);
    if (spent >= settings.dailyTokenBudget) {
      throw new ServiceUnavailableException(
        `Daily token budget of ${settings.dailyTokenBudget.toLocaleString('en-US')} tokens is exhausted and auto-throttle is enabled.`,
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    if (this.config.get('AI_MODE') === 'demo')
      return deterministicEmbedding(text);
    const ollamaUrl = this.config.get<string>('OLLAMA_URL');
    if (ollamaUrl) {
      const response = await fetch(
        `${ollamaUrl.replace(/\/$/, '')}/api/embeddings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.config.get(
              'OLLAMA_EMBEDDING_MODEL',
              'nomic-embed-text',
            ),
            prompt: text,
          }),
        },
      );
      if (response.ok) {
        const data = (await response.json()) as { embedding?: number[] };
        if (data.embedding?.length === 768) return data.embedding;
      }
    }
    const token = this.config.get<string>('HF_TOKEN');
    if (!token)
      throw new ServiceUnavailableException(
        'No embedding provider is configured. Set HF_TOKEN, OLLAMA_URL, or AI_MODE=demo.',
      );
    const url = this.config.get(
      'HF_EMBEDDING_URL',
      'https://api-inference.huggingface.co/pipeline/feature-extraction/nomic-ai/nomic-embed-text-v1.5',
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inputs: text }),
    });
    if (!response.ok)
      throw new ServiceUnavailableException(
        `Embedding provider returned ${response.status}.`,
      );
    const data = (await response.json()) as number[] | number[][];
    const embedding = Array.isArray(data[0])
      ? (data as number[][])[0]
      : (data as number[]);
    if (embedding.length !== 768)
      throw new ServiceUnavailableException(
        'Embedding provider returned an unexpected vector dimension.',
      );
    return embedding;
  }

  private isConfigured(provider: string): boolean {
    if (provider === 'DEMO') return this.config.get('AI_MODE') === 'demo';
    if (provider === 'AUTOAPP') return aiGatewayIsConfigured(this.config);
    if (provider === 'GROQ') return Boolean(this.config.get('GROQ_API_KEY'));
    if (provider === 'OPENROUTER')
      return Boolean(this.config.get('OPENROUTER_API_KEY'));
    if (provider === 'OLLAMA') return Boolean(this.config.get('OLLAMA_URL'));
    return false;
  }

  private generateWith(
    candidate: ProviderDescriptor,
    request: ChatRequest,
  ): ChatResult {
    if (candidate.provider === 'DEMO')
      return {
        provider: 'demo',
        model: candidate.model,
        stream: demoStream(request),
      };
    if (candidate.provider === 'OLLAMA')
      return {
        provider: 'ollama',
        model: candidate.model,
        stream: this.ollamaStream(candidate.model, request),
      };
    if (candidate.provider === 'AUTOAPP')
      return {
        provider: 'autoapp',
        model: candidate.model,
        stream: this.gatewayStream(candidate.model, request),
      };
    if (candidate.provider === 'GROQ')
      return {
        provider: 'groq',
        model: candidate.model,
        stream: this.openAiStream(
          'https://api.groq.com/openai/v1/chat/completions',
          this.config.getOrThrow('GROQ_API_KEY'),
          candidate.model,
          request,
        ),
      };
    if (candidate.provider === 'OPENROUTER')
      return {
        provider: 'openrouter',
        model: candidate.model,
        stream: this.openAiStream(
          'https://openrouter.ai/api/v1/chat/completions',
          this.config.getOrThrow('OPENROUTER_API_KEY'),
          candidate.model,
          request,
        ),
      };
    throw new ServiceUnavailableException(
      `Provider ${candidate.provider} is not available for automatic routing.`,
    );
  }

  private async *fallbackStream(
    candidates: ProviderDescriptor[],
    request: ChatRequest,
  ): AsyncIterable<string> {
    let lastError: unknown;
    for (const [index, candidate] of candidates.entries()) {
      try {
        const allowed = await this.quota.reserve(
          request.tenantId,
          candidate.provider.toLowerCase(),
          candidate.model,
          candidate.dailyLimit,
        );
        if (!allowed) {
          lastError = new ServiceUnavailableException(
            `${candidate.provider} daily budget is exhausted.`,
          );
          continue;
        }
        const result = this.generateWith(candidate, request);
        yield* result.stream;
        return;
      } catch (error) {
        lastError = error;
        if (index < candidates.length - 1) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              250 * (index + 1) + Math.floor(Math.random() * 150),
            ),
          );
        }
      }
    }
    throw new ServiceUnavailableException(
      lastError instanceof Error
        ? lastError.message
        : 'All approved AI providers failed.',
    );
  }

  private async *gatewayStream(
    model: string,
    request: ChatRequest,
  ): AsyncIterable<string> {
    const gateway = readAiGatewayConfig(this.config);
    yield* chatStream({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      model,
      messages: promptMessages(request),
      temperature: 0.2,
      timeoutMs: gateway.timeoutMs,
    });
  }

  private async *openAiStream(
    url: string,
    apiKey: string,
    model: string,
    request: ChatRequest,
  ): AsyncIterable<string> {
    yield* chatStream({
      baseUrl: url.replace(/\/chat\/completions\/?$/, ''),
      apiKey,
      model,
      messages: promptMessages(request),
      temperature: 0.2,
      timeoutMs: Number(this.config.get<string>('AI_TIMEOUT_MS') ?? 60_000),
    });
  }

  private async *ollamaStream(
    model: string,
    request: ChatRequest,
  ): AsyncIterable<string> {
    const endpoint = `${this.config.getOrThrow<string>('OLLAMA_URL').replace(/\/$/, '')}/api/chat`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: promptMessages(request),
      }),
    });
    if (!response.ok || !response.body)
      throw new ServiceUnavailableException(
        `Ollama returned ${response.status}.`,
      );
    const decoder = new TextDecoder();
    let remainder = '';
    for await (const part of response.body) {
      remainder += decoder.decode(part, { stream: true });
      const lines = remainder.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line) as { message?: { content?: string } };
        if (data.message?.content) yield data.message.content;
      }
    }
  }
}

/**
 * The system prompt follows the workspace language setting. It previously
 * hard-coded Indonesian instructions regardless of `request.language`, so an
 * English workspace still received Indonesian system guidance.
 */
function promptMessages(request: ChatRequest): ChatMessage[] {
  const context = request.context
    .map((hit, index) => `[${index + 1}] ${hit.sourceTitle}: ${hit.content}`)
    .join('\n\n');
  const system =
    request.language === 'en'
      ? [
          'You are a customer support assistant.',
          'Answer in English using only the context provided below.',
          'If the context is insufficient, say that a human teammate will follow up rather than guessing.',
          '',
          'Knowledge base:',
          context || '(no context)',
        ].join('\n')
      : [
          'Anda adalah asisten layanan pelanggan.',
          'Jawab dalam Bahasa Indonesia dan hanya gunakan konteks yang diberikan.',
          'Jika konteks tidak cukup, katakan bahwa tim manusia akan menindaklanjuti daripada menebak.',
          '',
          'Knowledge base:',
          context || '(tidak ada konteks)',
        ].join('\n');
  return [
    { role: 'system', content: system },
    ...(request.messages as ChatMessage[]),
  ];
}

async function* demoStream(request: ChatRequest): AsyncIterable<string> {
  const top = request.context[0];
  const english = request.language === 'en';
  const text = top
    ? english
      ? `Thanks for reaching out. Based on ${top.sourceTitle}: ${top.content.slice(0, 500)}${top.content.length > 500 ? '…' : ''}`
      : `Terima kasih atas pesanan Anda. Berdasarkan ${top.sourceTitle}: ${top.content.slice(0, 500)}${top.content.length > 500 ? '…' : ''}`
    : english
      ? 'Thanks for reaching out. I could not find enough information in the knowledge base to answer that. A teammate will follow up shortly.'
      : 'Terima kasih atas pesanan Anda. Saya belum menemukan informasi yang cukup di knowledge base. Tim kami akan menindaklanjuti secepatnya.';
  for (const word of text.split(/(\s+)/)) {
    await new Promise((resolve) => setTimeout(resolve, 8));
    yield word;
  }
}

function deterministicEmbedding(text: string): number[] {
  const vector = Array.from({ length: 768 }, () => 0);
  for (let index = 0; index < text.length; index += 1)
    vector[index % 768] += ((text.charCodeAt(index) % 97) - 48) / 100;
  const magnitude =
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}
