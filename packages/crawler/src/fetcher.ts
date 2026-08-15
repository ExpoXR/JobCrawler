import { AppError, classifyError, errorTypeForStatus, getConfig, getLogger } from '@ejc/shared';

import { assertUrlIsSafe, type UrlGuardOptions } from './ssrf';

/**
 * The single HTTP entry point for everything that leaves this system.
 *
 * Guarantees, in order:
 *   - every URL (and every redirect hop) passes the SSRF guard
 *   - responses are size-capped while streaming, so an oversized page cannot
 *     exhaust memory before we notice
 *   - non-HTML content types are refused early
 *   - timeouts always fire, and redirect chains are bounded
 */

export interface FetchOptions extends UrlGuardOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
  signal?: AbortSignal;
  /** Content types we are willing to parse. */
  allowedContentTypes?: readonly string[];
  method?: 'GET' | 'HEAD';
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  byteSize: number;
  durationMs: number;
  redirects: number;
  truncated: boolean;
}

const DEFAULT_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

function contentTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return allowed.some((entry) => normalized === entry || normalized.endsWith(`+${entry}`));
}

/** Reads at most `maxBytes`, then aborts the stream. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; byteSize: number; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', byteSize: 0, truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: merged.toString('utf8'), byteSize: merged.byteLength, truncated };
}

/**
 * Fetches a URL safely.
 *
 * Redirects are followed manually (`redirect: 'manual'`) so each hop can be
 * re-validated — following them automatically would let a public host redirect
 * us straight to an internal address.
 */
export async function safeFetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const config = getConfig();
  const logger = getLogger('fetcher');

  const timeoutMs = options.timeoutMs ?? config.crawler.timeoutMs;
  const maxBytes = options.maxBytes ?? config.crawler.maxPageBytes;
  const maxRedirects = options.maxRedirects ?? config.crawler.maxRedirects;
  const userAgent = options.userAgent ?? config.crawler.userAgent;
  const allowedContentTypes = options.allowedContentTypes ?? DEFAULT_CONTENT_TYPES;

  const guardOptions: UrlGuardOptions = {
    allowPrivateAddresses: options.allowPrivateAddresses ?? config.crawler.allowPrivateAddresses,
    blockedDomains: options.blockedDomains ?? config.crawler.blockedDomains,
  };
  if (options.resolve) guardOptions.resolve = options.resolve;

  const started = Date.now();
  let currentUrl = rawUrl;
  const seen = new Set<string>();

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (seen.has(currentUrl)) {
      throw new AppError('redirect_loop', 'Redirect loop detected', {
        context: { url: rawUrl },
      });
    }
    seen.add(currentUrl);

    const guarded = await assertUrlIsSafe(currentUrl, guardOptions);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(guarded.url, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: options.accept ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'accept-language': 'de,en;q=0.9',
        },
      });
    } catch (error) {
      throw new AppError(classifyError(error), `Fetch failed for ${guarded.hostname}`, {
        cause: error,
        context: { url: currentUrl, domain: guarded.hostname },
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new AppError('http_client', `Redirect without Location (${response.status})`, {
          context: { url: currentUrl, status: response.status },
        });
      }
      currentUrl = new URL(location, guarded.url).toString();
      await response.body?.cancel().catch(() => undefined);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError(
        errorTypeForStatus(response.status),
        `HTTP ${response.status} for ${guarded.hostname}`,
        { context: { url: currentUrl, status: response.status, domain: guarded.hostname } },
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentTypeAllowed(contentType, allowedContentTypes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError('invalid_html', `Unsupported content type: ${contentType}`, {
        context: { url: currentUrl, domain: guarded.hostname },
      });
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError('too_large', `Response exceeds ${maxBytes} bytes`, {
        context: { url: currentUrl, domain: guarded.hostname },
      });
    }

    const { text, byteSize, truncated } = await readCapped(response, maxBytes);
    const durationMs = Date.now() - started;

    logger.debug('Fetched', {
      url: currentUrl,
      domain: guarded.hostname,
      status: response.status,
      durationMs,
      byteSize,
    });

    return {
      url: rawUrl,
      finalUrl: currentUrl,
      status: response.status,
      contentType,
      body: text,
      byteSize,
      durationMs,
      redirects,
      truncated,
    };
  }

  throw new AppError('redirect_loop', `Exceeded ${maxRedirects} redirects`, {
    context: { url: rawUrl },
  });
}

/** Fetch that resolves to `undefined` instead of throwing, for optional sources. */
export async function tryFetch(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<FetchResult | undefined> {
  try {
    return await safeFetch(rawUrl, options);
  } catch (error) {
    getLogger('fetcher').debug('Fetch skipped', {
      url: rawUrl,
      errorType: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
