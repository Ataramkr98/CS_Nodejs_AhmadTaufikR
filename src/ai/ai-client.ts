import { ServiceUnavailableException } from '@nestjs/common';
import { redactSecrets } from './ai.config';

/**
 * OpenAI-compatible transport shared by every provider in this service.
 *
 * Groq, OpenRouter and the shared AI gateway all speak the same
 * `POST /chat/completions` dialect, so they all go through these helpers. That
 * keeps request shape, timeout behaviour and error wording identical no matter
 * which backend is selected.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  timeoutMs?: number;
  /** Outer abort signal (client disconnect, queue shutdown) merged with the timeout. */
  signal?: AbortSignal;
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}

export interface ChatCompletionResult {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}

const DEFAULT_TIMEOUT_MS = 60_000;

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** Combines the configured timeout with any caller-supplied abort signal. */
function buildSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (outer) signals.push(outer);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function buildBody(options: ChatCompletionOptions, stream: boolean): string {
  return JSON.stringify({
    model: options.model,
    stream,
    ...(stream && options.onUsage
      ? { stream_options: { include_usage: true } }
      : {}),
    temperature: options.temperature ?? 0.2,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.responseFormat
      ? { response_format: options.responseFormat }
      : {}),
    messages: options.messages,
  });
}

/**
 * Turns any transport failure into one predictable error. Never echoes the
 * Authorization header or the API key.
 */
export function normalizeAiError(error: unknown, label = 'AI provider'): Error {
  if (error instanceof ServiceUnavailableException) return error;
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown error';
  const aborted =
    (error instanceof Error && error.name === 'TimeoutError') ||
    /aborted|timed out/i.test(raw);
  const message = redactSecrets(raw);
  return new ServiceUnavailableException(
    aborted
      ? `${label} request timed out`
      : `${label} request failed: ${message}`,
  );
}

export async function chatComplete(
  options: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(endpoint(options.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: buildBody(options, false),
      signal: buildSignal(timeoutMs, options.signal),
    });
  } catch (error) {
    throw normalizeAiError(error);
  }
  if (!response.ok) {
    // The upstream body is intentionally not forwarded: it can contain
    // account identifiers and echoes of the request headers.
    throw new ServiceUnavailableException(
      `AI provider returned ${response.status}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  assertReply(content);
  return {
    content,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

export async function* chatStream(
  options: ChatCompletionOptions,
): AsyncIterable<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(endpoint(options.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: buildBody(options, true),
      signal: buildSignal(timeoutMs, options.signal),
    });
  } catch (error) {
    throw normalizeAiError(error);
  }
  if (!response.ok || !response.body) {
    throw new ServiceUnavailableException(
      `AI provider returned ${response.status}`,
    );
  }
  try {
    let prefix = '';
    let started = false;
    for await (const delta of responseText(response, options.onUsage)) {
      if (!started) {
        prefix += delta;
        // The gateway sometimes sends a credential failure as HTTP 200 text.
        // Hold that prefix until it can be checked, before leaking account
        // details into a customer's transcript or accepting it as a reply.
        const text = prefix.trimStart().toLowerCase();
        const denied = 'your subscription has expired.';
        if (!text || denied.startsWith(text) || text.startsWith(denied))
          continue;
        assertReply(prefix);
        started = true;
        yield prefix;
      } else {
        yield delta;
      }
    }
    if (!started) {
      assertReply(prefix);
      yield prefix;
    }
  } catch (error) {
    throw normalizeAiError(error);
  }
}

function assertReply(content: string): void {
  if (!content.trim()) {
    throw new ServiceUnavailableException(
      'AI provider returned an empty reply.',
    );
  }
  if (
    /^your subscription has expired\./i.test(content.trimStart()) &&
    /API key status:\s*expired/i.test(content)
  ) {
    throw new ServiceUnavailableException(
      'AI gateway subscription has expired. Renew its credential or configure another enabled provider.',
    );
  }
}

async function* responseText(
  response: Response,
  onUsage?: ChatCompletionOptions['onUsage'],
): AsyncIterable<string> {
  if (response.headers.get('content-type')?.includes('application/json')) {
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ProviderUsage;
    };
    reportUsage(payload.usage, onUsage);
    yield payload.choices?.[0]?.message?.content ?? '';
    return;
  }
  yield* parseSse(response.body!, onUsage);
}

interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function reportUsage(
  usage: ProviderUsage | undefined,
  onUsage?: ChatCompletionOptions['onUsage'],
) {
  if (
    usage &&
    Number.isInteger(usage.prompt_tokens) &&
    Number.isInteger(usage.completion_tokens) &&
    usage.prompt_tokens! >= 0 &&
    usage.completion_tokens! >= 0
  )
    onUsage?.({
      promptTokens: usage.prompt_tokens!,
      completionTokens: usage.completion_tokens!,
    });
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onUsage?: ChatCompletionOptions['onUsage'],
): AsyncIterable<string> {
  for await (const data of sseEvents(body)) {
    if (data === '[DONE]') return;
    if (!data.trim()) continue;
    let payload: {
      error?: unknown;
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: ProviderUsage;
      x_groq?: { usage?: ProviderUsage };
    };
    try {
      payload = JSON.parse(data) as typeof payload;
    } catch {
      throw new ServiceUnavailableException(
        'AI provider returned invalid stream data.',
      );
    }
    if (payload.error) {
      throw new ServiceUnavailableException(
        'AI provider reported a generation error.',
      );
    }
    reportUsage(payload.usage ?? payload.x_groq?.usage, onUsage);
    const content = payload.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content) yield content;
  }
}

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let remainder = '';
  let data: string[] = [];
  for await (const part of body) {
    remainder += decoder.decode(part, { stream: true });
    for (;;) {
      const end = remainder.search(/[\r\n]/);
      if (end < 0 || (remainder[end] === '\r' && end === remainder.length - 1))
        break;
      const line = remainder.slice(0, end);
      const length =
        remainder[end] === '\r' && remainder[end + 1] === '\n' ? 2 : 1;
      remainder = remainder.slice(end + length);
      if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      } else if (line === '' && data.length) {
        yield data.join('\n');
        data = [];
      }
    }
  }
  remainder += decoder.decode();
  // Some compatible gateways close without a final blank line.
  const finalLine = remainder.replace(/\r$/, '');
  if (finalLine.startsWith('data:'))
    data.push(finalLine.slice(5).replace(/^ /, ''));
  if (data.length) yield data.join('\n');
}
