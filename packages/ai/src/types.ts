/**
 * Provider-independent AI interfaces (plan section 22).
 *
 * Nothing outside this package knows which vendor is configured. Adding a
 * provider means implementing these two interfaces and registering a factory —
 * no changes anywhere else in the application.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for strict JSON output where it supports it. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  usage?: TokenUsage;
  durationMs: number;
}

export interface AiProvider {
  readonly key: string;
  readonly model: string;
  /** False when the provider has no credentials or endpoint configured. */
  readonly configured: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface EmbeddingRequest {
  input: string[];
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  provider: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly key: string;
  readonly model: string;
  readonly dimensions: number;
  readonly configured: boolean;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export interface ProviderCapabilities {
  chat: boolean;
  json: boolean;
  embeddings: boolean;
  streaming: boolean;
  local: boolean;
}
