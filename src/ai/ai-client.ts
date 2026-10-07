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
  return {
    content: data.choices?.[0]?.message?.content ?? '',
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
  yield* parseSse(response.body);
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let remainder = '';
  for await (const part of body) {
    remainder += decoder.decode(part, { stream: true });
    const lines = remainder.split('\n');
    remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const content = (
        JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        }
      ).choices?.[0]?.delta?.content;
      if (content) yield content;
    }
  }
}
