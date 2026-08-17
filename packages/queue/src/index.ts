import { getConfig, getLogger, type SearchQuery } from '@ejc/shared';
import { type ConnectionOptions, type Job, Queue, type QueueOptions, Worker } from 'bullmq';
import type { Processor, WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Queue definitions (plan section 24).
 *
 * Every asynchronous unit of work has its own queue so workers can be scaled
 * independently — crawling is I/O bound and slow, embedding is API-bound and
 * rate limited, matching is CPU bound. One shared queue would couple them.
 */

export const QUEUE_NAMES = [
  'company-discovery',
  'website-crawl',
  'job-discovery',
  'candidate-discovery',
  'data-normalization',
  'embedding',
  'ai-analysis',
  'verification',
  'research',
  'cleanup',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Payload shapes, one per queue. */
export interface JobPayloads {
  'company-discovery': { searchId: string; query: SearchQuery };
  'website-crawl': {
    searchId?: string;
    companyId: string;
    website: string;
    query?: SearchQuery;
  };
  'job-discovery': { searchId: string; companyId: string; query: SearchQuery };
  'candidate-discovery': { searchId: string; query: SearchQuery };
  'data-normalization': { searchId: string };
  embedding: { subjectType: 'job' | 'company' | 'candidate'; subjectId: string };
  'ai-analysis': { searchId: string; resultId: string };
  verification: { kind: 'job' | 'company' | 'candidate'; id: string };
  research: { searchId: string; jobId?: string; companyId?: string };
  cleanup: {
    task: 'expired-caches' | 'expired-searches' | 'stale-jobs' | 'backfill-embeddings';
  };
}

let connection: IORedis | undefined;

/**
 * Shared Redis connection.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ's blocking commands;
 * without it long-polling workers throw as soon as a command waits.
 */
export function getRedisConnection(): IORedis {
  if (connection) return connection;
  const config = getConfig();

  connection = new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  connection.on('error', (error: Error) => {
    getLogger('queue').error('Redis connection error', {
      errorType: 'queue_failure',
      message: error.message,
    });
  });

  return connection;
}

export function getConnectionOptions(): ConnectionOptions {
  return getRedisConnection() as unknown as ConnectionOptions;
}

const queues = new Map<QueueName, Queue>();

const DEFAULT_QUEUE_OPTIONS: Omit<QueueOptions, 'connection'> = {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    // Keep a short history for the admin dashboard, then discard.
    removeOnComplete: { age: 3600, count: 500 },
    removeOnFail: { age: 24 * 3600, count: 1000 },
  },
};

/** BullMQ 5 reserves `:` for its Redis key format and rejects it in custom IDs. */
export function normalizeJobId(jobId: string): string {
  return encodeURIComponent(jobId);
}

export function getQueue<T extends QueueName>(name: T): Queue<JobPayloads[T]> {
  const existing = queues.get(name);
  if (existing) return existing as Queue<JobPayloads[T]>;

  const queue = new Queue<JobPayloads[T]>(name, {
    ...DEFAULT_QUEUE_OPTIONS,
    connection: getConnectionOptions(),
  });
  queues.set(name, queue as unknown as Queue);
  return queue;
}

export async function enqueue<T extends QueueName>(
  name: T,
  payload: JobPayloads[T],
  options: { jobId?: string; delayMs?: number; priority?: number } = {},
): Promise<string | undefined> {
  // The queue's job-name type is narrowed per queue; the name is always the
  // queue's own name here, so a widening cast keeps the public API simple.
  const queue = getQueue(name) as unknown as Queue;
  const job = await queue.add(name, payload, {
    ...(options.jobId ? { jobId: normalizeJobId(options.jobId) } : {}),
    ...(options.delayMs ? { delay: options.delayMs } : {}),
    ...(options.priority ? { priority: options.priority } : {}),
  });
  return job.id;
}

export interface WorkerHandle {
  name: QueueName;
  worker: Worker;
}

/** Creates a worker with structured logging around each job. */
export function createWorker<T extends QueueName>(
  name: T,
  processor: (job: Job<JobPayloads[T]>) => Promise<void>,
  options: { concurrency?: number } = {},
): WorkerHandle {
  const config = getConfig();
  const logger = getLogger('worker').child({ queue: name });

  const workerOptions: WorkerOptions = {
    connection: getConnectionOptions(),
    concurrency: options.concurrency ?? config.worker.concurrency,
  };

  const worker = new Worker(
    name,
    (async (job: Job<JobPayloads[T]>) => {
      const started = Date.now();
      try {
        await processor(job);
        logger.info('Job completed', { jobId: job.id, durationMs: Date.now() - started });
      } catch (error) {
        logger.error('Job failed', {
          jobId: job.id,
          durationMs: Date.now() - started,
          retryCount: job.attemptsMade,
          errorType: 'queue_failure',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }) as unknown as Processor,
    workerOptions,
  );

  worker.on('error', (error) => {
    logger.error('Worker error', { errorType: 'queue_failure', message: error.message });
  });

  return { name, worker };
}

export interface QueueStats {
  name: QueueName;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export async function getQueueStats(): Promise<QueueStats[]> {
  return Promise.all(
    QUEUE_NAMES.map(async (name) => {
      const queue = getQueue(name);
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      return {
        name,
        waiting: counts['waiting'] ?? 0,
        active: counts['active'] ?? 0,
        completed: counts['completed'] ?? 0,
        failed: counts['failed'] ?? 0,
        delayed: counts['delayed'] ?? 0,
      };
    }),
  );
}

export async function checkRedisHealth(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    await getRedisConnection().ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = undefined;
  }
}

export { Queue, Worker };
export type { Job as QueueJob };
