import { clearExpiredCaches, deleteExpiredSearchSessions } from '@ejc/database';
import { createWorker, enqueue, getQueue, type WorkerHandle } from '@ejc/queue';
import { getConfig, getLogger } from '@ejc/shared';

import { enqueueDueVerifications } from './verification';

/**
 * Cleanup and scheduling.
 *
 * Repeatable BullMQ jobs replace a separate cron process: retention, cache
 * expiry and re-crawl scheduling all run from this one queue, which keeps the
 * deployment to `web + worker + postgres + redis`.
 */

const logger = getLogger('worker');

export function registerCleanupWorkers(): WorkerHandle[] {
  const cleanup = createWorker(
    'cleanup',
    async (job) => {
      switch (job.data.task) {
        case 'expired-caches': {
          const removed = await clearExpiredCaches();
          logger.info('Cleared expired caches', removed);
          break;
        }
        case 'expired-searches': {
          const removed = await deleteExpiredSearchSessions();
          logger.info('Removed expired search sessions', { removed });
          break;
        }
        case 'stale-jobs': {
          await enqueueDueVerifications();
          break;
        }
        default:
          break;
      }
    },
    { concurrency: 1 },
  );

  void scheduleMaintenance();

  return [cleanup];
}

/**
 * Installs the repeatable maintenance jobs. Idempotent: BullMQ keys repeatable
 * jobs by name plus pattern, so restarting the worker does not duplicate them.
 */
export async function scheduleMaintenance(): Promise<void> {
  const config = getConfig();

  try {
    const queue = getQueue('cleanup');

    await queue.add(
      'cleanup',
      { task: 'expired-caches' },
      { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: 'maintenance:caches' },
    );
    await queue.add(
      'cleanup',
      { task: 'expired-searches' },
      { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'maintenance:searches' },
    );
    await queue.add(
      'cleanup',
      { task: 'stale-jobs' },
      {
        repeat: { every: Math.max(1, config.retention.recrawlJobHours) * 60 * 60 * 1000 },
        jobId: 'maintenance:verification',
      },
    );

    logger.info('Maintenance schedule installed');
  } catch (error) {
    logger.warn('Could not install maintenance schedule', {
      errorType: 'queue_failure',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Manual trigger used by the admin dashboard. */
export async function runCleanupNow(task: 'expired-caches' | 'expired-searches' | 'stale-jobs') {
  await enqueue('cleanup', { task });
}
