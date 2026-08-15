import {
  clearExpiredCaches,
  deleteExpiredSearchSessions,
  findCompaniesMissingEmbedding,
  findJobsMissingEmbedding,
} from '@ejc/database';
import { isEmbeddingEnabled } from '@ejc/ai';
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
        case 'backfill-embeddings': {
          const queued = await backfillEmbeddings();
          logger.info('Queued embedding backfill', queued);
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
 * Queues embeddings for rows that have none.
 *
 * The discovery path enqueues embeddings as it writes, but that enqueue is
 * fire-and-forget: if Redis was briefly unavailable, or embeddings were only
 * configured later, those rows would never get a vector. This sweep is the
 * safety net that makes the pipeline eventually consistent.
 */
export async function backfillEmbeddings(
  limit = 200,
): Promise<{ jobs: number; companies: number }> {
  if (!isEmbeddingEnabled()) return { jobs: 0, companies: 0 };

  const [jobs, companies] = await Promise.all([
    findJobsMissingEmbedding(limit),
    findCompaniesMissingEmbedding(limit),
  ]);

  for (const job of jobs) {
    await enqueue(
      'embedding',
      { subjectType: 'job', subjectId: job.id },
      { jobId: `embed:job:${job.id}` },
    );
  }
  for (const company of companies) {
    await enqueue(
      'embedding',
      { subjectType: 'company', subjectId: company.id },
      { jobId: `embed:company:${company.id}` },
    );
  }

  return { jobs: jobs.length, companies: companies.length };
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
      { task: 'backfill-embeddings' },
      { repeat: { every: 30 * 60 * 1000 }, jobId: 'maintenance:embeddings' },
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
export async function runCleanupNow(
  task: 'expired-caches' | 'expired-searches' | 'stale-jobs' | 'backfill-embeddings',
): Promise<void> {
  await enqueue('cleanup', { task });
}
