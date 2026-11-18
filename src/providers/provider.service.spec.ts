import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { QuotaService } from '../usage/quota.service';
import { ChatRequest, ProviderDescriptor } from '../common/contracts';
import { ProviderService, tokenUsage } from './provider.service';

function response(content: string) {
  return new Response(
    'data: ' +
      JSON.stringify({ choices: [{ delta: { content } }] }) +
      '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('Provider routing', () => {
  let service: ProviderService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let listMock: jest.SpiedFunction<ProviderService['list']>;
  const request: ChatRequest = {
    tenantId: 'tenant-1',
    language: 'en',
    context: [],
    messages: [{ role: 'user', content: 'Hello' }],
  };
  const candidates: ProviderDescriptor[] = ['primary', 'fallback'].map(
    (model, index) => ({
      provider: 'AUTOAPP',
      model,
      enabled: true,
      configured: true,
      priority: index,
      privacy: 'approved',
    }),
  );

  beforeEach(() => {
    const tx = {
      tenantSettings: {
        findUnique: jest.fn().mockResolvedValue({ autoThrottle: false }),
      },
    };
    const prisma = {
      withTenant: jest.fn((_id, callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const quota = {
      reserve: jest.fn().mockResolvedValue(true),
    } as unknown as QuotaService;
    service = new ProviderService(
      prisma,
      new ConfigService({
        AI_API_KEY: 'test-credential',
        GROQ_API_KEY: 'groq-test-credential',
      }),
      quota,
    );
    listMock = jest.spyOn(service, 'list').mockResolvedValue(candidates);
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('routes GPT-OSS 20B through Groq using its own credential', async () => {
    listMock.mockResolvedValue([
      {
        provider: 'GROQ',
        model: 'openai/gpt-oss-20b',
        enabled: true,
        configured: true,
        priority: 1,
        privacy: 'approved',
      },
    ]);
    fetchMock.mockResolvedValueOnce(response('Reply from Groq'));
    const result = await service.generate(request);
    let reply = '';
    for await (const part of result.stream) reply += part;
    expect(reply).toBe('Reply from Groq');
    expect(result.provider).toBe('groq');
    expect(result.model).toBe('openai/gpt-oss-20b');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer groq-test-credential',
    );
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: 'openai/gpt-oss-20b',
      stream: true,
    });
  });

  it.each([
    '',
    'Your subscription has expired.\nAPI key status: expired\nName: private-account',
  ])(
    'tries the fallback for an unusable HTTP 200 reply: %j',
    async (content) => {
      fetchMock
        .mockResolvedValueOnce(response(content))
        .mockResolvedValueOnce(response('A working reply'));
      const result = await service.generate(request);
      let contentResult = '';
      for await (const part of result.stream) contentResult += part;
      expect(result.model).toBe('fallback');
      expect(contentResult).toBe('A working reply');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('builds an operator drafting prompt with facts, brand voice and a separate regeneration reference', async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        'JNE and J&T are available. Which destination postcode do you mean?',
      ),
    );
    const previousDraft = 'Maaf, saya tidak memiliki informasi.';
    const result = await service.generate({
      ...request,
      mode: 'operator-draft',
      language: 'id',
      brandVoice: 'Ramah dan singkat.',
      previousDraft,
      context: [
        {
          chunkId: 'shipping-1',
          sourceId: 'shipping',
          sourceTitle: 'Kebijakan Pengiriman',
          content: 'Kurir: JNE dan J&T.',
          score: 0,
        },
      ],
    });
    for await (const part of result.stream) {
      void part;
    }
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain('Bahasa Indonesia');
    expect(body.messages[0].content).toContain('Ramah dan singkat.');
    expect(body.messages[0].content).toContain('Kurir: JNE dan J&T.');
    expect(body.messages[0].content).not.toContain(previousDraft);
    expect(body.messages.at(-1)?.role).toBe('user');
    expect(body.messages.at(-1)?.content).toBe('Hello');
    expect(JSON.parse(body.messages.at(-2)!.content)).toMatchObject({
      previousDraftReference: previousDraft,
    });
  });

  it('reports exhausted providers instead of marking an empty reply successful', async () => {
    fetchMock.mockImplementation(async () => response(''));
    await expect(service.generate(request)).rejects.toThrow('empty reply');
  });

  it('tries the auto-reply model first while preserving fallbacks', async () => {
    fetchMock.mockResolvedValueOnce(response('Selected model reply'));
    const result = await service.generate({
      ...request,
      preferredModel: 'fallback',
      brandVoice: 'Warm and concise.',
    });
    for await (const part of result.stream) void part;
    expect(result.model).toBe('fallback');
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('fallback');
    expect(body.messages[0].content).toContain('24/7');
    expect(body.messages[0].content).toContain('Warm and concise.');
  });

  it('falls back to priority routing if the selected model becomes unavailable', async () => {
    fetchMock.mockResolvedValueOnce(response('Routed reply'));
    const result = await service.generate({
      ...request,
      preferredModel: 'disabled-model',
    });
    for await (const part of result.stream) void part;
    expect(result.model).toBe('primary');
  });

  it('does not append a second model answer after a stream has already emitted text', async () => {
    const part = JSON.stringify({
      choices: [{ delta: { content: 'Partial answer' } }],
    });
    fetchMock.mockResolvedValueOnce(
      new Response('data: ' + part + '\n\ndata: {"error":{}}\n\n'),
    );
    const result = await service.generate(request);
    const read = async () => {
      for await (const _part of result.stream) {
        void _part;
      }
    };
    await expect(read()).rejects.toThrow('generation error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accounts for system instructions and knowledge context when a provider omits totals', async () => {
    fetchMock.mockResolvedValueOnce(response('A grounded reply'));
    const prompt = {
      ...request,
      context: [
        {
          chunkId: 'chunk',
          sourceId: 'source',
          sourceTitle: 'Policy',
          content: 'Important knowledge context. '.repeat(100),
          score: 1,
        },
      ],
    };
    const result = await service.generate(prompt);
    for await (const part of result.stream) void part;
    const usage = tokenUsage(result, prompt, 'A grounded reply');
    expect(usage.tokensIn).toBeGreaterThan(700);
    expect(usage.tokensOut).toBe(4);
    expect(result.usage?.estimated).toBe(true);
  });

  it('persists the selected provider totals instead of replacing them with character estimates', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"content":"Reply"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":987,"completion_tokens":52}}\n\n' +
          'data: [DONE]\n\n',
      ),
    );
    const result = await service.generate(request);
    for await (const part of result.stream) void part;
    expect(tokenUsage(result, request, 'Reply')).toEqual({
      tokensIn: 987,
      tokensOut: 52,
    });
    expect(result.usage?.estimated).toBe(false);
  });
});
