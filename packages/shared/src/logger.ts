/**
 * Structured JSON logging (plan section 38).
 *
 * Deliberately dependency-free: one line of JSON per event, with the fields the
 * plan asks for (searchId, jobId, provider, url, domain, company, status,
 * durationMs, retryCount, errorType) carried as an explicit context object.
 *
 * Secrets must never reach the log stream, so every value is passed through a
 * redactor before serialisation.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

export interface LogContext {
  searchId?: string;
  jobId?: string;
  companyId?: string;
  candidateId?: string;
  provider?: string;
  queue?: string;
  url?: string;
  domain?: string;
  company?: string;
  status?: string | number;
  durationMs?: number;
  retryCount?: number;
  errorType?: string;
  [key: string]: unknown;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|password|secret|token|authorization|cookie|credential)/i;
const REDACTED = '[redacted]';

/** Recursively replaces secret-looking values. Depth-capped to stay cheap. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  context?: LogContext;
  /** Injection point for tests. */
  sink?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const name = options.name ?? 'app';
  const baseContext = options.context ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_WEIGHT[level];

  const write = (logLevel: Exclude<LogLevel, 'silent'>, message: string, context?: LogContext) => {
    if (LEVEL_WEIGHT[logLevel] < threshold) return;
    const payload = {
      time: now().toISOString(),
      level: logLevel,
      name,
      msg: message,
      ...(redact({ ...baseContext, ...context }) as Record<string, unknown>),
    };
    sink(JSON.stringify(payload));
  };

  return {
    trace: (message, context) => write('trace', message, context),
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    child: (context) =>
      createLogger({ ...options, level, name, context: { ...baseContext, ...context } }),
  };
}

let rootLogger: Logger | undefined;

export function getLogger(name?: string): Logger {
  rootLogger ??= createLogger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    name: 'expojobcrawler',
  });
  return name ? rootLogger.child({ module: name }) : rootLogger;
}
