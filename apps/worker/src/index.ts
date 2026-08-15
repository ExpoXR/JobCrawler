import { checkDatabaseHealth, closePool } from '@ejc/database';
import { closeQueues, createWorker, type WorkerHandle } from '@ejc/queue';
import { syncProviderRegistry } from '@ejc/providers';
import { getConfig, getLogger } from '@ejc/shared';

import { registerCleanupWorkers } from './handlers/cleanup';
import { registerDiscoveryWorkers } from './handlers/discovery';
import { registerEnrichmentWorkers } from './handlers/enrichment';
import { registerVerificationWorkers } from './handlers/verification';

/**
 * Worker entry point.
 *
 * Each queue gets its own BullMQ worker so concurrency can be tuned per kind of
 * work, and the process shuts down cleanly so in-flight jobs are returned to
 * the queue rather than lost.
 */

const logger = getLogger('worker');

async function main(): Promise<void> {
  const config = getConfig();

  const health = await checkDatabaseHealth();
  if (!health.ok) {
    logger.error('Database is not reachable; exiting', { error: health.error });
    process.exitCode = 1;
    return;
  }
  if (!health.postgis || !health.pgvector) {
    logger.warn('Expected extensions are missing', {
      postgis: health.postgis,
      pgvector: health.pgvector,
    });
  }

  await syncProviderRegistry();

  const workers: WorkerHandle[] = [
    ...registerDiscoveryWorkers(),
    ...registerEnrichmentWorkers(),
    ...registerVerificationWorkers(),
    ...registerCleanupWorkers(),
  ];

  logger.info('Workers started', {
    queues: workers.map((handle) => handle.name).join(','),
    concurrency: config.worker.concurrency,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    // `close()` waits for active jobs; anything still queued stays queued.
    await Promise.allSettled(workers.map((handle) => handle.worker.close()));
    await closeQueues();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((error: unknown) => {
  logger.error('Worker failed to start', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

export { createWorker };
