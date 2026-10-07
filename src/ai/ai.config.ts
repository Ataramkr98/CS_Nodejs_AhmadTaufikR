import { ConfigService } from '@nestjs/config';

/**
 * Single source of truth for the shared OpenAI-compatible AI gateway.
 *
 * Every AI call in this service reads its endpoint, credential, timeout and
 * retry policy from here so that no module hardcodes a URL or a key.
 */

export const AI_MODEL_IDS = {
  MINIMAX_M3: 'minimax-m3',
  GLM_53_FLASH: 'glm-5.3-flash',
  KIMI_K3: 'kimi-k3',
} as const;

export type AiModelId = (typeof AI_MODEL_IDS)[keyof typeof AI_MODEL_IDS];

/** Cheapest fast model: the default for interactive work. */
export const AI_DEFAULT_MODEL: AiModelId = AI_MODEL_IDS.MINIMAX_M3;
/** Cheapest per token: used when a call fails over. */
export const AI_FALLBACK_MODEL: AiModelId = AI_MODEL_IDS.GLM_53_FLASH;

export type AiFeature =
  'chat' | 'analyze' | 'generate' | 'summarize' | 'embedding-context';

const FEATURE_ENV_KEYS: Record<AiFeature, string> = {
  chat: 'AI_MODEL_CHAT',
  analyze: 'AI_MODEL_ANALYZE',
  generate: 'AI_MODEL_GENERATE',
  summarize: 'AI_MODEL_SUMMARIZE',
  'embedding-context': 'AI_MODEL_EMBEDDING_CONTEXT',
};

export interface AiGatewayConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

const DEFAULT_BASE_URL = 'https://ai.autoapp.biz.id/v1';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

function envInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readAiGatewayConfig(config: ConfigService): AiGatewayConfig {
  const apiKey = config.get<string>('AI_API_KEY')?.trim() ?? '';
  if (!apiKey) {
    throw new Error(
      'AI_API_KEY is not set. Copy .env.example to .env and fill the AI gateway credentials.',
    );
  }
  return {
    baseUrl: (
      config.get<string>('AI_BASE_URL')?.trim() || DEFAULT_BASE_URL
    ).replace(/\/+$/, ''),
    apiKey,
    timeoutMs: envInt(config, 'AI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    maxRetries: envInt(config, 'AI_MAX_RETRIES', DEFAULT_MAX_RETRIES),
  };
}

export function aiGatewayIsConfigured(config: ConfigService): boolean {
  return Boolean(config.get<string>('AI_API_KEY')?.trim());
}

/**
 * Resolves the model for a feature: a per-feature override wins, then the
 * explicit default, then the built-in MINIMAX_M3 default.
 */
export function resolveAiModel(
  config: ConfigService,
  feature: AiFeature,
): string {
  const override = config.get<string>(FEATURE_ENV_KEYS[feature])?.trim();
  if (override) return override;
  return config.get<string>('AI_MODEL_DEFAULT')?.trim() || AI_DEFAULT_MODEL;
}

/**
 * Strips anything that looks like a bearer credential before a value is
 * logged or surfaced to a caller.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}
