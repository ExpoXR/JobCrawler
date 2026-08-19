/**
 * Error taxonomy (plan section 35).
 *
 * Every failure is classified so that one broken source degrades a search
 * instead of failing it, and so logs carry a stable `errorType`.
 */

export type ErrorType =
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'http_client'
  | 'http_server'
  | 'rate_limited'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'redirect_loop'
  | 'too_large'
  | 'invalid_html'
  | 'invalid_xml'
  | 'invalid_structured_data'
  | 'blocked_by_robots'
  | 'blocked_address'
  | 'blocked_domain'
  | 'invalid_url'
  | 'provider_unavailable'
  | 'ai_failure'
  | 'queue_failure'
  | 'validation'
  | 'not_configured'
  | 'unknown';

export class AppError extends Error {
  readonly type: ErrorType;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(
    type: ErrorType,
    message: string,
    options: { retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.type = type;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(type);
    this.context = options.context ?? {};
  }
}

const DEFAULT_RETRYABLE = new Set<ErrorType>([
  'timeout',
  'dns',
  'http_server',
  'rate_limited',
  'provider_unavailable',
  'queue_failure',
]);

/** Maps an HTTP status to the taxonomy above. */
export function errorTypeForStatus(status: number): ErrorType {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'http_server';
  if (status >= 400) return 'http_client';
  return 'unknown';
}

/** Best-effort classification of an arbitrary thrown value. */
export function classifyError(error: unknown): ErrorType {
  if (error instanceof AppError) return error.type;
  if (!(error instanceof Error)) return 'unknown';

  const code = (error as NodeJS.ErrnoException).code ?? '';
  const message = error.message.toLowerCase();

  if (error.name === 'AbortError' || code === 'ETIMEDOUT' || message.includes('timeout')) {
    return 'timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || message.includes('getaddrinfo')) return 'dns';
  if (code.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || message.includes('certificate')) {
    return 'tls';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return 'provider_unavailable';
  }
  return 'unknown';
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  return DEFAULT_RETRYABLE.has(classifyError(error));
}

/** Message safe to show a user: never leaks internals or secrets. */
export function publicErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    switch (error.type) {
      case 'validation':
        return error.message;
      case 'not_configured':
        return 'This feature is not configured on this deployment.';
      case 'unauthenticated':
        return 'Please sign in to continue.';
      // Both of these carry an authored, non-sensitive message. Collapsing them
      // to one generic string made a CSRF rejection and a missing admin role
      // indistinguishable, in the UI and in the logs.
      case 'forbidden':
      case 'not_found':
        return error.message;
      case 'rate_limited':
        return 'The upstream source is rate limiting requests. Please retry shortly.';
      case 'provider_unavailable':
        return 'An external source is temporarily unavailable.';
      default:
        return 'The request could not be completed.';
    }
  }
  return 'Unexpected error.';
}
