import { AppError, getConfig, withTimeout } from '@ejc/shared';

import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
} from './types';

/**
 * Concrete AI providers.
 *
 * Each one speaks its vendor's HTTP API directly — no SDKs. That keeps the
 * dependency surface (and the supply-chain risk) small, and the request shapes
 * here are stable, well-documented endpoints.
 *
 * API keys come from configuration and are only ever placed in request headers.
 */

interface HttpOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

async function postJson<T>(options: HttpOptions): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await withTimeout(
      fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      }),
      options.timeoutMs,
      'AI request',
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new AppError(
        response.status === 429 ? 'rate_limited' : 'ai_failure',
        `AI provider returned ${response.status}`,
        { context: { status: response.status, detail: detail.slice(0, 300) } },
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('ai_failure', 'AI provider request failed', { cause: error });
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export interface ProviderSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export class OpenAiProvider implements AiProvider {
  readonly key = 'openai';
  readonly model: string;
  readonly configured: boolean;
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    this.settings = settings;
    this.model = settings.model || 'gpt-4o-mini';
    this.configured = settings.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.configured) throw new AppError('not_configured', 'OpenAI API key is missing');
    const started = Date.now();

    const payload = await postJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>({
      url: `${this.settings.baseUrl || 'https://api.openai.com/v1'}/chat/completions`,
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      body: {
        model: this.model,
        messages: request.messages,
        temperature: request.temperature ?? this.settings.temperature,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      },
      signal: request.signal,
      timeoutMs: this.settings.timeoutMs,
    });

    const result: CompletionResult = {
      text: payload.choices?.[0]?.message?.content ?? '',
      model: this.model,
      provider: this.key,
      durationMs: Date.now() - started,
    };
    if (payload.usage) {
      result.usage = {
        ...(payload.usage.prompt_tokens !== undefined
          ? { inputTokens: payload.usage.prompt_tokens }
          : {}),
        ...(payload.usage.completion_tokens !== undefined
          ? { outputTokens: payload.usage.completion_tokens }
          : {}),
      };
    }
    return result;
  }
}

export class AnthropicProvider implements AiProvider {
  readonly key = 'anthropic';
  readonly model: string;
  readonly configured: boolean;
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    this.settings = settings;
    this.model = settings.model || 'claude-sonnet-4-5';
    this.configured = settings.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.configured) throw new AppError('not_configured', 'Anthropic API key is missing');
    const started = Date.now();

    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    const payload = await postJson<{
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>({
      url: `${this.settings.baseUrl || 'https://api.anthropic.com/v1'}/messages`,
      headers: {
        'x-api-key': this.settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: this.model,
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? this.settings.temperature,
        ...(system ? { system } : {}),
        messages,
      },
      signal: request.signal,
      timeoutMs: this.settings.timeoutMs,
    });

    const result: CompletionResult = {
      text: payload.content?.map((block) => block.text ?? '').join('') ?? '',
      model: this.model,
      provider: this.key,
      durationMs: Date.now() - started,
    };
    if (payload.usage) {
      result.usage = {
        ...(payload.usage.input_tokens !== undefined
          ? { inputTokens: payload.usage.input_tokens }
          : {}),
        ...(payload.usage.output_tokens !== undefined
          ? { outputTokens: payload.usage.output_tokens }
          : {}),
      };
    }
    return result;
  }
}

export class GeminiProvider implements AiProvider {
  readonly key = 'gemini';
  readonly model: string;
  readonly configured: boolean;
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    this.settings = settings;
    this.model = settings.model || 'gemini-2.0-flash';
    this.configured = settings.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.configured) throw new AppError('not_configured', 'Gemini API key is missing');
    const started = Date.now();

    const base = this.settings.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const systemInstruction = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const payload = await postJson<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>({
      url: `${base}/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: { 'x-goog-api-key': this.settings.apiKey },
      body: {
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        contents: request.messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
        generationConfig: {
          temperature: request.temperature ?? this.settings.temperature,
          ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
        },
      },
      signal: request.signal,
      timeoutMs: this.settings.timeoutMs,
    });

    const result: CompletionResult = {
      text:
        payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
      model: this.model,
      provider: this.key,
      durationMs: Date.now() - started,
    };
    if (payload.usageMetadata) {
      result.usage = {
        ...(payload.usageMetadata.promptTokenCount !== undefined
          ? { inputTokens: payload.usageMetadata.promptTokenCount }
          : {}),
        ...(payload.usageMetadata.candidatesTokenCount !== undefined
          ? { outputTokens: payload.usageMetadata.candidatesTokenCount }
          : {}),
      };
    }
    return result;
  }
}

export class OllamaProvider implements AiProvider {
  readonly key = 'ollama';
  readonly model: string;
  readonly configured: boolean;
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    this.settings = settings;
    this.model = settings.model || 'llama3.1';
    // Ollama is local and needs no key — only an endpoint.
    this.configured = (settings.baseUrl || 'http://localhost:11434').length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const base = this.settings.baseUrl || 'http://localhost:11434';

    const payload = await postJson<{
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    }>({
      url: `${base}/api/chat`,
      headers: {},
      body: {
        model: this.model,
        messages: request.messages,
        stream: false,
        ...(request.json ? { format: 'json' } : {}),
        options: { temperature: request.temperature ?? this.settings.temperature },
      },
      signal: request.signal,
      timeoutMs: this.settings.timeoutMs,
    });

    const result: CompletionResult = {
      text: payload.message?.content ?? '',
      model: this.model,
      provider: this.key,
      durationMs: Date.now() - started,
    };
    if (payload.prompt_eval_count !== undefined || payload.eval_count !== undefined) {
      result.usage = {
        ...(payload.prompt_eval_count !== undefined
          ? { inputTokens: payload.prompt_eval_count }
          : {}),
        ...(payload.eval_count !== undefined ? { outputTokens: payload.eval_count } : {}),
      };
    }
    return result;
  }
}

/** No-op provider used when `AI_PROVIDER=none`. Callers fall back to heuristics. */
export class DisabledAiProvider implements AiProvider {
  readonly key = 'none';
  readonly model = '';
  readonly configured = false;

  complete(): Promise<CompletionResult> {
    return Promise.reject(new AppError('not_configured', 'No AI provider is configured'));
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly key = 'openai';
  readonly model: string;
  readonly dimensions: number;
  readonly configured: boolean;
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings, dimensions: number) {
    this.settings = settings;
    this.model = settings.model || 'text-embedding-3-small';
    this.dimensions = dimensions;
    this.configured = settings.apiKey.length > 0;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (!this.configured) throw new AppError('not_configured', 'OpenAI API key is missing');

    const payload = await postJson<{ data?: Array<{ embedding?: number[] }> }>({
      url: `${this.settings.baseUrl || 'https://api.openai.com/v1'}/embeddings`,
      headers: { authorization: `Bearer ${this.settings.apiKey}` },
      body: { model: this.model, input: request.input, dimensions: this.dimensions },
      signal: request.signal,
      timeoutMs: this.settings.timeoutMs,
    });

    return {
      vectors: (payload.data ?? []).map((entry) => entry.embedding ?? []),
      model: this.model,
      provider: this.key,
      dimensions: this.dimensions,
    };
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly key = 'ollama';
  readonly model: string;
  readonly dimensions: number;
  readonly configured = true;
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings, dimensions: number) {
    this.settings = settings;
    this.model = settings.model || 'nomic-embed-text';
    this.dimensions = dimensions;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const base = this.settings.baseUrl || 'http://localhost:11434';
    const payload = await postJson<{ embeddings?: number[][] }>({
      url: `${base}/api/embed`,
      headers: {},
      body: { model: this.model, input: request.input },
      signal: request.signal,
      timeoutMs: this.settings.timeoutMs,
    });

    return {
      vectors: payload.embeddings ?? [],
      model: this.model,
      provider: this.key,
      dimensions: this.dimensions,
    };
  }
}

export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly key = 'none';
  readonly model = '';
  readonly dimensions = 0;
  readonly configured = false;

  embed(): Promise<EmbeddingResult> {
    return Promise.reject(new AppError('not_configured', 'No embedding provider is configured'));
  }
}

let cachedAi: AiProvider | undefined;
let cachedEmbedding: EmbeddingProvider | undefined;

/** Builds the configured chat provider. */
export function getAiProvider(): AiProvider {
  if (cachedAi) return cachedAi;
  const config = getConfig();
  const settings: ProviderSettings = {
    apiKey: config.ai.apiKey,
    baseUrl: config.ai.baseUrl,
    model: config.ai.model,
    temperature: config.ai.temperature,
    timeoutMs: config.ai.timeoutMs,
  };

  switch (config.ai.provider) {
    case 'openai':
      cachedAi = new OpenAiProvider(settings);
      break;
    case 'anthropic':
      cachedAi = new AnthropicProvider(settings);
      break;
    case 'gemini':
      cachedAi = new GeminiProvider(settings);
      break;
    case 'ollama':
      cachedAi = new OllamaProvider(settings);
      break;
    default:
      cachedAi = new DisabledAiProvider();
  }
  return cachedAi;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cachedEmbedding) return cachedEmbedding;
  const config = getConfig();
  const settings: ProviderSettings = {
    apiKey: config.embedding.apiKey,
    baseUrl: config.embedding.baseUrl,
    model: config.embedding.model,
    temperature: 0,
    timeoutMs: config.ai.timeoutMs,
  };

  switch (config.embedding.provider) {
    case 'openai':
      cachedEmbedding = new OpenAiEmbeddingProvider(settings, config.embedding.dimensions);
      break;
    case 'ollama':
      cachedEmbedding = new OllamaEmbeddingProvider(settings, config.embedding.dimensions);
      break;
    default:
      cachedEmbedding = new DisabledEmbeddingProvider();
  }
  return cachedEmbedding;
}

/** Test helper. */
export function resetProviderCache(): void {
  cachedAi = undefined;
  cachedEmbedding = undefined;
}
