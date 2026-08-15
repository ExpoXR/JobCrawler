import { createHash } from 'node:crypto';

import {
  type Candidate,
  type Company,
  cosineSimilarity,
  getConfig,
  getLogger,
  type Job,
  mapLimit,
  type SearchQuery,
  truncate,
} from '@ejc/shared';

import { getEmbeddingProvider } from './providers';

/**
 * Embedding generation (plan section 23).
 *
 * The text an entity is embedded from is built here, in one place, so that a
 * job and a query are always described in the same vocabulary. Change the
 * builders and you must re-embed — hence the `EMBEDDING_TEXT_VERSION` marker.
 */

export const EMBEDDING_TEXT_VERSION = 'v1';

export function buildJobEmbeddingText(job: Job, company?: Company): string {
  return truncate(
    [
      job.title,
      company?.name ?? job.companyName ?? '',
      [job.city, job.region, job.country].filter(Boolean).join(', '),
      job.workModel !== 'unknown' ? job.workModel : '',
      job.employmentType !== 'unknown' ? job.employmentType : '',
      job.seniority !== 'unknown' ? job.seniority : '',
      job.skills.join(', '),
      job.technologies.join(', '),
      company?.industry ?? '',
      job.description ?? '',
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n'),
    8000,
  );
}

export function buildCompanyEmbeddingText(company: Company): string {
  return truncate(
    [
      company.name,
      company.industry ?? '',
      [company.city, company.region, company.country].filter(Boolean).join(', '),
      company.technologies.join(', '),
      company.services.join(', '),
      company.description ?? '',
      company.aiSummary ?? '',
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n'),
    8000,
  );
}

export function buildCandidateEmbeddingText(candidate: Candidate): string {
  return truncate(
    [
      candidate.publicTitle ?? '',
      candidate.approximateLocation ?? '',
      candidate.skills.join(', '),
      candidate.technologies.join(', '),
      candidate.aiSummary ?? '',
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n'),
    4000,
  );
}

export function buildQueryEmbeddingText(query: SearchQuery): string {
  return truncate(
    [
      query.role,
      query.locationText,
      [...query.requiredSkills, ...query.preferredSkills, ...query.technologies].join(', '),
      query.seniority ?? '',
      query.industries.join(', '),
      query.workModels.join(', '),
      query.keywords.join(', '),
      query.rawQuery ?? '',
    ]
      .filter((part) => part.trim().length > 0)
      .join('\n'),
    4000,
  );
}

export function embeddingCacheKey(text: string, model: string): string {
  return createHash('sha256')
    .update(`${EMBEDDING_TEXT_VERSION}|${model}|${text}`)
    .digest('hex');
}

/**
 * In-process embedding cache.
 *
 * Search results repeat heavily inside one session (the same company appears
 * under several jobs), so a small LRU-ish map removes most duplicate calls
 * without needing Redis on the hot path.
 */
const memoryCache = new Map<string, number[]>();
const MAX_CACHE_ENTRIES = 2000;

function cacheGet(key: string): number[] | undefined {
  return memoryCache.get(key);
}

function cacheSet(key: string, vector: number[]): void {
  if (memoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next();
    if (!oldest.done) memoryCache.delete(oldest.value);
  }
  memoryCache.set(key, vector);
}

export interface EmbedTextsResult {
  vectors: Array<number[] | undefined>;
  provider: string;
  model: string;
}

/**
 * Embeds a batch of texts, returning `undefined` per item on failure.
 *
 * Never throws: without embeddings the system falls back to lexical scoring,
 * which is worse but perfectly functional (plan section 35).
 */
export async function embedTexts(
  texts: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<EmbedTextsResult> {
  const provider = getEmbeddingProvider();
  if (!provider.configured || texts.length === 0) {
    return { vectors: texts.map(() => undefined), provider: provider.key, model: provider.model };
  }

  const config = getConfig();
  const logger = getLogger('embeddings');

  const keys = texts.map((text) => embeddingCacheKey(text, provider.model));
  const vectors: Array<number[] | undefined> = keys.map((key) => cacheGet(key));

  const pendingIndexes = vectors
    .map((vector, index) => (vector === undefined ? index : -1))
    .filter((index) => index >= 0);

  if (pendingIndexes.length === 0) {
    return { vectors, provider: provider.key, model: provider.model };
  }

  // Batch to keep individual requests small and cancellable.
  const batchSize = 16;
  const batches: number[][] = [];
  for (let i = 0; i < pendingIndexes.length; i += batchSize) {
    batches.push(pendingIndexes.slice(i, i + batchSize));
  }

  await mapLimit(batches, config.embedding.maxConcurrency, async (batch) => {
    const input = batch.map((index) => texts[index] ?? '');
    try {
      const result = await provider.embed({
        input,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      batch.forEach((targetIndex, position) => {
        const vector = result.vectors[position];
        if (vector && vector.length > 0) {
          vectors[targetIndex] = vector;
          const key = keys[targetIndex];
          if (key) cacheSet(key, vector);
        }
      });
    } catch (error) {
      logger.warn('Embedding batch failed', {
        provider: provider.key,
        errorType: 'ai_failure',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { vectors, provider: provider.key, model: provider.model };
}

export async function embedText(
  text: string,
  options: { signal?: AbortSignal } = {},
): Promise<number[] | undefined> {
  const result = await embedTexts([text], options);
  return result.vectors[0];
}

/** Cosine similarity mapped from [-1, 1] to [0, 1] for use as a score. */
export function similarityScore(a: readonly number[], b: readonly number[]): number {
  return Math.max(0, Math.min(1, (cosineSimilarity(a, b) + 1) / 2));
}

export function isEmbeddingEnabled(): boolean {
  return getEmbeddingProvider().configured;
}
