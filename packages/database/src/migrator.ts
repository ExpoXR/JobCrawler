import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { getLogger } from '@ejc/shared';

import { getPool } from './pool';

/**
 * Forward-only SQL migrations.
 *
 * Files are plain `.sql`, applied in filename order inside a transaction, and
 * recorded with a checksum so an edited-after-the-fact migration is caught
 * rather than silently skipped.
 */

export interface MigrationRecord {
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATIONS_TABLE = 'schema_migrations';

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function resolveMigrationsDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  // packages/database/src -> repository root
  return path.resolve(import.meta.dirname, '../../../migrations');
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: checksumOf(sql) };
    }),
  );
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function getAppliedMigrations(): Promise<MigrationRecord[]> {
  await ensureMigrationsTable();
  const result = await getPool().query<{ name: string; checksum: string; applied_at: Date }>(
    `SELECT name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  return result.rows.map((row) => ({
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export interface MigrationStatus {
  applied: MigrationRecord[];
  pending: MigrationFile[];
  drifted: string[];
}

export async function getMigrationStatus(dir?: string): Promise<MigrationStatus> {
  const migrationsDir = resolveMigrationsDir(dir);
  const files = await readMigrationFiles(migrationsDir);
  const applied = await getAppliedMigrations();
  const appliedByName = new Map(applied.map((record) => [record.name, record]));

  const pending: MigrationFile[] = [];
  const drifted: string[] = [];

  for (const file of files) {
    const record = appliedByName.get(file.name);
    if (!record) {
      pending.push(file);
    } else if (record.checksum !== file.checksum) {
      drifted.push(file.name);
    }
  }

  return { applied, pending, drifted };
}

export interface MigrateResult {
  appliedNow: string[];
  alreadyApplied: number;
}

/**
 * Applies every pending migration. Each file runs in its own transaction so a
 * failure leaves the database at the last complete migration.
 */
export async function migrate(dir?: string): Promise<MigrateResult> {
  const logger = getLogger('migrator');
  const status = await getMigrationStatus(dir);

  if (status.drifted.length > 0) {
    throw new Error(
      `Migration checksum mismatch for: ${status.drifted.join(', ')}. ` +
        'Applied migrations must never be edited — add a new migration instead.',
    );
  }

  const appliedNow: string[] = [];
  const pool = getPool();

  for (const file of status.pending) {
    const client = await pool.connect();
    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`, [
        file.name,
        file.checksum,
      ]);
      await client.query('COMMIT');
      appliedNow.push(file.name);
      logger.info('Applied migration', { migration: file.name, durationMs: Date.now() - started });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(
        `Migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      client.release();
    }
  }

  return { appliedNow, alreadyApplied: status.applied.length };
}
