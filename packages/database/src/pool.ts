import { getConfig, getLogger } from '@ejc/shared';
import pg from 'pg';

const { Pool } = pg;

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

let pool: pg.Pool | undefined;

/**
 * Lazily-created connection pool.
 *
 * Every package talks to Postgres through this one accessor so connection
 * limits stay meaningful and no module opens its own pool.
 */
export function getPool(): pg.Pool {
  if (pool) return pool;

  const config = getConfig();
  const logger = getLogger('database');

  pool = new Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'expojobcrawler',
  });

  pool.on('error', (error) => {
    logger.error('Idle database client error', { errorType: 'unknown', error: error.message });
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

/**
 * Parameterised query helper.
 *
 * All call sites must pass values as parameters — string interpolation into SQL
 * is never acceptable here (plan section 37).
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const started = Date.now();
  try {
    return await getPool().query<T>(text, params as unknown[]);
  } finally {
    const durationMs = Date.now() - started;
    if (durationMs > 1000) {
      getLogger('database').warn('Slow query', {
        durationMs,
        statement: text.slice(0, 120).replace(/\s+/g, ' '),
      });
    }
  }
}

export async function queryRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const result = await query<T>(text, params);
  return result.rows[0];
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A failed rollback means the connection is gone; the release below
      // discards it and the original error is what matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  postgis: boolean;
  pgvector: boolean;
  error?: string;
}

export async function checkDatabaseHealth(): Promise<DbHealth> {
  const started = Date.now();
  try {
    const rows = await queryRows<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])`,
      [['postgis', 'vector']],
    );
    const names = new Set(rows.map((row) => row.extname));
    return {
      ok: true,
      latencyMs: Date.now() - started,
      postgis: names.has('postgis'),
      pgvector: names.has('vector'),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      postgis: false,
      pgvector: false,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}
