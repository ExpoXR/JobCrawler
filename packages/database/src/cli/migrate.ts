#!/usr/bin/env tsx
/**
 * Migration CLI.
 *
 *   npm run migrate           apply pending migrations
 *   npm run migrate:status    show what would run
 */
import { closePool } from '../pool';
import { getMigrationStatus, migrate } from '../migrator';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';

  if (command === 'status') {
    const status = await getMigrationStatus();
    console.log(`Applied: ${status.applied.length}`);
    for (const record of status.applied) {
      console.log(`  ✓ ${record.name} (${record.appliedAt.toISOString()})`);
    }
    console.log(`Pending: ${status.pending.length}`);
    for (const file of status.pending) console.log(`  • ${file.name}`);
    if (status.drifted.length > 0) {
      console.error(`Checksum drift: ${status.drifted.join(', ')}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command !== 'up') {
    console.error(`Unknown command: ${command}. Use "up" or "status".`);
    process.exitCode = 1;
    return;
  }

  const result = await migrate();
  if (result.appliedNow.length === 0) {
    console.log(`No pending migrations (${result.alreadyApplied} already applied).`);
    return;
  }
  for (const name of result.appliedNow) console.log(`Applied ${name}`);
  console.log(`Done: ${result.appliedNow.length} migration(s) applied.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
