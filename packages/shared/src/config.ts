import { z } from 'zod';

/**
 * Central, validated runtime configuration.
 *
 * Everything the system is allowed to tune at runtime lives here so that the
 * resource limits from the plan (section 36) have exactly one source of truth.
 * Secrets are only ever read on the server — never re-exported to the browser.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const intFromEnv = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

const csvValues = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean));

/**
 * `openai_compatible` is not a vendor but a shape: any endpoint speaking
 * OpenAI's `/chat/completions`. One option therefore covers LM Studio, vLLM,
 * llama.cpp, OpenRouter, Groq and Together — it reuses `OpenAiProvider` with a
 * custom base URL, and is how a local model is configured.
 */
export const AI_PROVIDERS = [
  'none',
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'openai_compatible',
] as const;
export const EMBEDDING_PROVIDERS = ['none', 'openai', 'ollama', 'openai_compatible'] as const;

export type AiProviderName = (typeof AI_PROVIDERS)[number];
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),

  DATABASE_URL: z.string().default('postgresql://expojobcrawler:expojobcrawler@localhost:5432/expojobcrawler'),
  DATABASE_POOL_MAX: intFromEnv(10, 1, 200),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  WORKER_CONCURRENCY: intFromEnv(4, 1, 64),

  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default(''),
  // Bootstrap only: the first administrator is seeded from these when the users
  // table is empty. After that, accounts are managed in the admin dashboard.
  ADMIN_EMAIL: z.string().default(''),
  AUTH_SESSION_TTL_HOURS: intFromEnv(24 * 7, 1, 24 * 365),
  AUTH_SESSION_ABSOLUTE_TTL_HOURS: intFromEnv(24 * 30, 1, 24 * 365),

  // How many reverse proxies sit in front of the app. `x-forwarded-for` is
  // client-controlled, so only the last N hops were written by infrastructure we
  // trust; 0 means "not behind a proxy" and the header is ignored entirely.
  TRUSTED_PROXY_HOPS: intFromEnv(0, 0, 10),
  // 'report-only' observes without breaking; 'enforce' blocks; 'off' omits it.
  CSP_MODE: z.enum(['enforce', 'report-only', 'off']).default('report-only'),

  GEOCODING_PROVIDER: z.string().default('nominatim'),
  NOMINATIM_BASE_URL: z.string().default('https://nominatim.openstreetmap.org'),
  OVERPASS_BASE_URL: z.string().default('https://overpass-api.de/api/interpreter'),
  OVERPASS_FALLBACK_URLS: csvValues,

  CRAWLER_USER_AGENT: z
    .string()
    .default('ExpoXR-Research/0.1 (+https://github.com/ExpoXR/ExpoJobCrawler)'),
  CRAWLER_CONTACT_EMAIL: z.string().default(''),

  CRAWL_MAX_DOMAINS_PER_SEARCH: intFromEnv(25, 1, 500),
  CRAWL_MAX_PAGES_PER_DOMAIN: intFromEnv(15, 1, 200),
  CRAWL_MAX_SITEMAP_ENTRIES: intFromEnv(2000, 1, 100_000),
  CRAWL_MAX_PAGE_BYTES: intFromEnv(2_000_000, 1024, 50_000_000),
  CRAWL_TIMEOUT_MS: intFromEnv(15_000, 1000, 120_000),
  CRAWL_DEFAULT_DELAY_MS: intFromEnv(1000, 0, 60_000),
  CRAWL_MAX_REDIRECTS: intFromEnv(5, 0, 20),
  CRAWL_MAX_RETRIES: intFromEnv(2, 0, 10),
  CRAWL_RESPECT_ROBOTS: booleanish.default(true),
  CRAWL_BLOCKED_DOMAINS: csv,
  CRAWL_ALLOW_PRIVATE_ADDRESSES: booleanish.default(false),

  SEARCH_MAX_RESULTS: intFromEnv(200, 1, 5000),
  SEARCH_MAX_DURATION_MS: intFromEnv(180_000, 5000, 1_800_000),
  SEARCH_DEFAULT_RADIUS_KM: intFromEnv(50, 1, 1000),
  SEARCH_MAX_RADIUS_KM: intFromEnv(250, 1, 5000),

  AI_PROVIDER: z.enum(AI_PROVIDERS).default('none'),
  AI_MODEL: z.string().default(''),
  AI_API_KEY: z.string().default(''),
  AI_BASE_URL: z.string().default(''),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  AI_TIMEOUT_MS: intFromEnv(30_000, 1000, 600_000),
  AI_MAX_CONCURRENCY: intFromEnv(2, 1, 32),

  EMBEDDING_PROVIDER: z.enum(EMBEDDING_PROVIDERS).default('none'),
  EMBEDDING_MODEL: z.string().default(''),
  EMBEDDING_API_KEY: z.string().default(''),
  EMBEDDING_BASE_URL: z.string().default(''),
  EMBEDDING_DIMENSIONS: intFromEnv(1536, 8, 8192),
  EMBEDDING_MAX_CONCURRENCY: intFromEnv(2, 1, 32),
  // Embedding calls are short; they should not inherit the chat timeout.
  EMBEDDING_TIMEOUT_MS: intFromEnv(20_000, 1000, 600_000),

  // 32 bytes of base64. Required before the dashboard will accept an API key;
  // without it the app refuses to store one rather than storing it weakly.
  SETTINGS_ENCRYPTION_KEY: z.string().default(''),

  RECRAWL_JOB_HOURS: intFromEnv(24, 1, 8760),
  RECRAWL_COMPANY_DAYS: intFromEnv(14, 1, 3650),
  RECRAWL_CANDIDATE_DAYS: intFromEnv(30, 1, 3650),
  DATA_RETENTION_DAYS: intFromEnv(365, 1, 3650),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  env: RawEnv['NODE_ENV'];
  logLevel: RawEnv['LOG_LEVEL'];
  database: { url: string; poolMax: number };
  redis: { url: string };
  web: { baseUrl: string };
  admin: { username: string; password: string; email: string; enabled: boolean };
  auth: {
    sessionTtlHours: number;
    sessionAbsoluteTtlHours: number;
  };
  security: {
    trustedProxyHops: number;
    cspMode: 'enforce' | 'report-only' | 'off';
  };
  geo: {
    provider: string;
    nominatimBaseUrl: string;
    overpassBaseUrl: string;
    overpassFallbackUrls: string[];
  };
  crawler: {
    userAgent: string;
    contactEmail: string;
    maxDomainsPerSearch: number;
    maxPagesPerDomain: number;
    maxSitemapEntries: number;
    maxPageBytes: number;
    timeoutMs: number;
    defaultDelayMs: number;
    maxRedirects: number;
    maxRetries: number;
    respectRobots: boolean;
    blockedDomains: string[];
    allowPrivateAddresses: boolean;
  };
  search: {
    maxResults: number;
    maxDurationMs: number;
    defaultRadiusKm: number;
    maxRadiusKm: number;
  };
  worker: { concurrency: number };
  ai: {
    provider: AiProviderName;
    model: string;
    apiKey: string;
    baseUrl: string;
    temperature: number;
    timeoutMs: number;
    maxConcurrency: number;
  };
  embedding: {
    provider: EmbeddingProviderName;
    model: string;
    apiKey: string;
    baseUrl: string;
    dimensions: number;
    maxConcurrency: number;
    timeoutMs: number;
  };
  retention: {
    recrawlJobHours: number;
    recrawlCompanyDays: number;
    recrawlCandidateDays: number;
    dataRetentionDays: number;
  };
}

export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;

  return {
    env: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    redis: { url: env.REDIS_URL },
    web: { baseUrl: env.PUBLIC_BASE_URL },
    admin: {
      username: env.ADMIN_USERNAME,
      password: env.ADMIN_PASSWORD,
      email: env.ADMIN_EMAIL,
      enabled: env.ADMIN_PASSWORD.length > 0,
    },
    auth: {
      sessionTtlHours: env.AUTH_SESSION_TTL_HOURS,
      sessionAbsoluteTtlHours: env.AUTH_SESSION_ABSOLUTE_TTL_HOURS,
    },
    security: {
      trustedProxyHops: env.TRUSTED_PROXY_HOPS,
      cspMode: env.CSP_MODE,
    },
    geo: {
      provider: env.GEOCODING_PROVIDER,
      nominatimBaseUrl: env.NOMINATIM_BASE_URL.replace(/\/+$/, ''),
      overpassBaseUrl: env.OVERPASS_BASE_URL,
      overpassFallbackUrls: env.OVERPASS_FALLBACK_URLS,
    },
    crawler: {
      userAgent: env.CRAWLER_USER_AGENT,
      contactEmail: env.CRAWLER_CONTACT_EMAIL,
      maxDomainsPerSearch: env.CRAWL_MAX_DOMAINS_PER_SEARCH,
      maxPagesPerDomain: env.CRAWL_MAX_PAGES_PER_DOMAIN,
      maxSitemapEntries: env.CRAWL_MAX_SITEMAP_ENTRIES,
      maxPageBytes: env.CRAWL_MAX_PAGE_BYTES,
      timeoutMs: env.CRAWL_TIMEOUT_MS,
      defaultDelayMs: env.CRAWL_DEFAULT_DELAY_MS,
      maxRedirects: env.CRAWL_MAX_REDIRECTS,
      maxRetries: env.CRAWL_MAX_RETRIES,
      respectRobots: env.CRAWL_RESPECT_ROBOTS,
      blockedDomains: env.CRAWL_BLOCKED_DOMAINS,
      allowPrivateAddresses: env.CRAWL_ALLOW_PRIVATE_ADDRESSES,
    },
    search: {
      maxResults: env.SEARCH_MAX_RESULTS,
      maxDurationMs: env.SEARCH_MAX_DURATION_MS,
      defaultRadiusKm: env.SEARCH_DEFAULT_RADIUS_KM,
      maxRadiusKm: env.SEARCH_MAX_RADIUS_KM,
    },
    worker: { concurrency: env.WORKER_CONCURRENCY },
    ai: {
      provider: env.AI_PROVIDER,
      model: env.AI_MODEL,
      apiKey: env.AI_API_KEY,
      baseUrl: env.AI_BASE_URL,
      temperature: env.AI_TEMPERATURE,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxConcurrency: env.AI_MAX_CONCURRENCY,
    },
    embedding: {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      apiKey: env.EMBEDDING_API_KEY,
      baseUrl: env.EMBEDDING_BASE_URL,
      dimensions: env.EMBEDDING_DIMENSIONS,
      maxConcurrency: env.EMBEDDING_MAX_CONCURRENCY,
      timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    },
    retention: {
      recrawlJobHours: env.RECRAWL_JOB_HOURS,
      recrawlCompanyDays: env.RECRAWL_COMPANY_DAYS,
      recrawlCandidateDays: env.RECRAWL_CANDIDATE_DAYS,
      dataRetentionDays: env.DATA_RETENTION_DAYS,
    },
  };
}

let cached: AppConfig | undefined;

/** Process-wide config singleton. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test helper — drops the memoised config so a new env can be loaded. */
export function resetConfigCache(): void {
  cached = undefined;
}
