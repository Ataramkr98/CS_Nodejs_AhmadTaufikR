import { chatComplete, chatStream, parseSse } from './ai-client';

function body(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function text(stream: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const delta of stream) result += delta;
  return result;
}

const options = {
  baseUrl: 'https://gateway.example/v1',
  apiKey: 'test-credential',
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'Hello' }],
};

const delta = (content: string) =>
  JSON.stringify({ choices: [{ delta: { content } }] });

describe('AI response transport', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['\n', '\r\n', '\r'])(
    'parses split SSE frames with %j line endings',
    async (newline) => {
      const source =
        ': heartbeat' +
        newline +
        newline +
        'data: ' +
        delta('Hello 🌏') +
        newline +
        newline +
        'data: [DONE]' +
        newline +
        newline;
      await expect(text(parseSse(body([...source])))).resolves.toBe('Hello 🌏');
    },
  );

  it('preserves a final delta when a gateway closes without a final newline', async () => {
    await expect(
      text(parseSse(body(['data: ' + delta('Final reply')]))),
    ).resolves.toBe('Final reply');
  });

  it('joins multiple data lines in an SSE event', async () => {
    const source =
      'data: {"choices": [\ndata: {"delta": {"content": "Reply"}}]}\n\n';
    await expect(text(parseSse(body([source])))).resolves.toBe('Reply');
  });

  it('accepts a JSON completion when a compatible gateway ignores streaming', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'A real reply' } }] }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(text(chatStream(options))).resolves.toBe('A real reply');
  });

  it('rejects an empty successful stream so routing can try another provider', async () => {
    fetchMock.mockResolvedValue(
      new Response(body(['data: [DONE]\n\n']), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await expect(text(chatStream(options))).rejects.toThrow('empty reply');
  });

  it('does not expose a credential-expiry notice as customer-facing AI text', async () => {
    const notice = [
      'Your subscription ',
      'has expired.\n\nAPI key ',
      'status: expired\nName: private-account\nQuota: private-quota',
    ];
    fetchMock.mockResolvedValue(
      new Response(body(notice.map((part) => 'data: ' + delta(part) + '\n\n'))),
    );
    const emitted: string[] = [];
    const read = async () => {
      for await (const part of chatStream(options)) emitted.push(part);
    };
    await expect(read()).rejects.toThrow('AI gateway subscription has expired');
    expect(emitted).toEqual([]);
  });

  it('rejects structured stream errors without echoing upstream account details', async () => {
    fetchMock.mockResolvedValue(
      new Response(body(['data: {"error":{"message":"private-account"}}\n\n'])),
    );
    await expect(text(chatStream(options))).rejects.toThrow(
      'AI provider reported a generation error.',
    );
  });

  it('rejects malformed stream data without returning an empty reply', async () => {
    fetchMock.mockResolvedValue(new Response(body(['data: invalid-json\n\n'])));
    await expect(text(chatStream(options))).rejects.toThrow(
      'invalid stream data',
    );
  });

  it('rejects blank non-streaming completions too', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
      ),
    );
    await expect(chatComplete(options)).rejects.toThrow('empty reply');
  });

  it.each(['usage', 'x_groq'])(
    'captures terminal %s token totals without emitting them as reply text',
    async (field) => {
      const usage = { prompt_tokens: 832, completion_tokens: 43 };
      const terminal = field === 'usage' ? { usage } : { x_groq: { usage } };
      fetchMock.mockResolvedValue(
        new Response(
          body([
            'data: ' + delta('Grounded answer') + '\n\n',
            'data: ' + JSON.stringify({ choices: [], ...terminal }) + '\n\n',
            'data: [DONE]\n\n',
          ]),
        ),
      );
      const onUsage = jest.fn();
      await expect(text(chatStream({ ...options, onUsage }))).resolves.toBe(
        'Grounded answer',
      );
      expect(onUsage).toHaveBeenCalledWith({
        promptTokens: 832,
        completionTokens: 43,
      });
      expect(
        JSON.parse(fetchMock.mock.calls[0][1]?.body as string).stream_options,
      ).toEqual({ include_usage: true });
    },
  );

  it('captures usage when a compatible provider responds with JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Reply' } }],
          usage: { prompt_tokens: 410, completion_tokens: 17 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const onUsage = jest.fn();
    await text(chatStream({ ...options, onUsage }));
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 410,
      completionTokens: 17,
    });
  });
});
