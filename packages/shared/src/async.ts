import { AppError, isRetryable } from './errors';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('timeout', 'Aborted before delay'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError('timeout', 'Aborted during delay'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Minimal concurrency limiter — avoids pulling in a dependency for 20 lines. */
export function createLimiter(concurrency: number) {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const waiting: Array<() => void> = [];

  const next = () => {
    if (active >= max) return;
    const run = waiting.shift();
    if (!run) return;
    active += 1;
    run();
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}

/** Runs tasks with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Overrides the default `isRetryable` classification. */
  shouldRetry?: (error: unknown) => boolean;
}

/** Exponential backoff with full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const shouldRetry = options.shouldRetry ?? isRetryable;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.round(Math.random() * ceiling);
      options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}

/** Rejects with a timeout AppError if the promise outlives `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AppError('timeout', `${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
