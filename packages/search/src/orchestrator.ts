import { applyParsedQuery, parseNaturalLanguageQuery } from '@ejc/ai';
import {
  createSearchSession,
  getSearchSession,
  getSettingOr,
  saveSearchResults,
  type SearchResultInput,
  updateSearchProgress,
} from '@ejc/database';
import { enqueue } from '@ejc/queue';
import {
  AppError,
  getConfig,
  getLogger,
  parseSearchQuery,
  type SearchQuery,
  type SearchStage,
} from '@ejc/shared';

import { resolveLocation } from './geocode';
import { searchLocalCandidates, searchLocalIndex } from './localSearch';

/**
 * Search orchestration (plan section 7).
 *
 * The contract with the UI:
 *   1. `startSearch` returns as soon as indexed results are saved — the user
 *      always sees something immediately.
 *   2. Live discovery continues in the background via queues and updates the
 *      same search session, which the UI polls or streams.
 *
 * Nothing here blocks on crawling.
 */

/** Progress weights: each stage's share of the 0–100 bar. */
const STAGE_PERCENT: Record<SearchStage, number> = {
  queued: 0,
  searching_database: 10,
  discovering_companies: 25,
  searching_job_sources: 40,
  checking_company_websites: 50,
  reading_sitemaps: 60,
  analyzing_career_pages: 70,
  extracting_jobs: 78,
  searching_profiles: 82,
  generating_embeddings: 86,
  calculating_matches: 92,
  researching_top_results: 96,
  completed: 100,
  failed: 100,
};

const STAGE_MESSAGE: Record<SearchStage, string> = {
  queued: 'Search queued',
  searching_database: 'Searching database',
  discovering_companies: 'Discovering companies',
  searching_job_sources: 'Searching job sources',
  checking_company_websites: 'Checking company websites',
  reading_sitemaps: 'Reading sitemaps',
  analyzing_career_pages: 'Analyzing career pages',
  extracting_jobs: 'Extracting jobs',
  searching_profiles: 'Searching profiles',
  generating_embeddings: 'Generating embeddings',
  calculating_matches: 'Calculating matches',
  researching_top_results: 'Researching top results',
  completed: 'Completed',
  failed: 'Search failed',
};

export async function advanceStage(
  searchId: string,
  stage: SearchStage,
  detail?: { message?: string; resultCount?: number; error?: string },
): Promise<void> {
  await updateSearchProgress(searchId, {
    stage,
    percent: STAGE_PERCENT[stage],
    message: detail?.message ?? STAGE_MESSAGE[stage],
    ...(detail?.resultCount !== undefined ? { resultCount: detail.resultCount } : {}),
    ...(detail?.error ? { error: detail.error } : {}),
  });
}

export interface StartSearchInput {
  /** Structured filters from the form. */
  query: unknown;
  /** Free text to parse; merged into the structured query. */
  naturalLanguage?: string;
  /** Skip live discovery — used by tests and by the "search index only" mode. */
  indexOnly?: boolean;
  /** Owner of the search. Undefined keeps it anonymous and publicly readable. */
  userId?: string | undefined;
  signal?: AbortSignal;
}

export interface StartSearchResult {
  searchId: string;
  query: SearchQuery;
  immediateResults: number;
  liveDiscoveryStarted: boolean;
}

/**
 * Creates a search, returns indexed results immediately, and kicks off live
 * discovery in the background.
 */
export async function startSearch(input: StartSearchInput): Promise<StartSearchResult> {
  const logger = getLogger('search');
  const config = getConfig();

  let query = parseSearchQuery(input.query);

  if (input.naturalLanguage?.trim()) {
    const parsed = await parseNaturalLanguageQuery(input.naturalLanguage, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    query = applyParsedQuery(query, parsed.parsed);
    query.rawQuery = input.naturalLanguage;
  }

  query.radiusKm = Math.min(query.radiusKm, config.search.maxRadiusKm);

  // Geocode before creating the session so the session row carries the point.
  if (!query.location && query.locationText) {
    const location = await resolveLocation(
      query.locationText,
      input.signal ? input.signal : undefined,
    );
    if (location) query.location = location;
  }

  if (!query.location) {
    throw new AppError('validation', `Could not resolve the location "${query.locationText}"`);
  }

  const searchId = await createSearchSession(query, input.userId);
  await advanceStage(searchId, 'searching_database');

  let immediateResults = 0;
  try {
    const results =
      query.mode === 'candidates'
        ? await searchLocalCandidates(query, { limit: config.search.maxResults })
        : (await searchLocalIndex(query, { limit: config.search.maxResults })).items;

    const inputs: SearchResultInput[] = results.map((item) => ({
      kind: item.kind,
      ...(item.job ? { jobId: item.job.id } : {}),
      ...(item.kind === 'potential_employer' && item.company ? { companyId: item.company.id } : {}),
      ...(item.candidate ? { candidateId: item.candidate.id } : {}),
      match: item.match,
      ...(item.distanceKm !== undefined ? { distanceKm: item.distanceKm } : {}),
    }));

    await saveSearchResults(searchId, inputs);
    immediateResults = inputs.length;
  } catch (error) {
    logger.error('Local search failed', {
      searchId,
      message: error instanceof Error ? error.message : String(error),
    });
    await advanceStage(searchId, 'searching_database', {
      message: 'Indexed search failed; continuing with live discovery',
      error: 'local-search-failed',
    });
  }

  /*
   * Live discovery is opt-in twice over: the user asks for it per search, and an
   * operator can switch it off for the whole deployment. `crawler.enabled` has
   * been seeded in `settings` since migration 0007 without anything reading it;
   * this is that switch.
   */
  const crawlingAllowed = await getSettingOr('crawler.enabled', true).catch(() => true);
  const wantsDiscovery = query.crawlWebsitesInRadius && !input.indexOnly;

  let liveDiscoveryStarted = false;
  if (wantsDiscovery && crawlingAllowed) {
    try {
      if (query.mode === 'candidates') {
        await enqueue('candidate-discovery', { searchId, query }, { jobId: `candidates:${searchId}` });
      } else {
        await enqueue('company-discovery', { searchId, query }, { jobId: `discovery:${searchId}` });
      }
      liveDiscoveryStarted = true;
      await advanceStage(searchId, 'discovering_companies', { resultCount: immediateResults });
    } catch (error) {
      // No Redis? The indexed results still stand; say so instead of failing.
      logger.warn('Could not start live discovery', {
        searchId,
        errorType: 'queue_failure',
        message: error instanceof Error ? error.message : String(error),
      });
      await advanceStage(searchId, 'completed', {
        message: 'Showing indexed results only (background workers unavailable)',
        resultCount: immediateResults,
        error: 'queue-unavailable',
      });
    }
  } else {
    await advanceStage(searchId, 'completed', {
      message: wantsDiscovery
        ? 'Live crawling is disabled on this deployment; showing indexed results'
        : 'Indexed results only — tick "crawl company websites" to search live',
      resultCount: immediateResults,
    });
  }

  logger.info('Search started', {
    searchId,
    immediateResults,
    liveDiscoveryStarted,
    radiusKm: query.radiusKm,
    crawlRequested: query.crawlWebsitesInRadius,
  });

  return { searchId, query, immediateResults, liveDiscoveryStarted };
}

/** Reloads the stored query for a search, e.g. when a worker resumes it. */
export async function getSearchQuery(searchId: string): Promise<SearchQuery | undefined> {
  const session = await getSearchSession(searchId);
  return session?.query;
}
