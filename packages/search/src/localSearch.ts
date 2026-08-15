import {
  buildQueryEmbeddingText,
  embedText,
  isEmbeddingEnabled,
  similarityScore,
} from '@ejc/ai';
import {
  findCandidates,
  findCompaniesWithinRadius,
  findJobsWithinRadius,
  getCompanyById,
} from '@ejc/database';
import { scoreCandidate, scoreJob, scorePotentialEmployer } from '@ejc/matching';
import {
  type Company,
  getLogger,
  haversineKm,
  type SearchQuery,
  type SearchResultItem,
} from '@ejc/shared';

/**
 * Phase one of every search (plan section 7): answer immediately from what is
 * already indexed, then let live discovery improve on it.
 *
 * This function must stay fast — it runs synchronously inside the request that
 * creates a search, so the user sees results before any crawling starts.
 */

export interface LocalSearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface LocalSearchResult {
  items: SearchResultItem[];
  /** Companies found in radius, reused by the discovery stage. */
  companies: Company[];
}

export async function searchLocalIndex(
  query: SearchQuery,
  options: LocalSearchOptions = {},
): Promise<LocalSearchResult> {
  const logger = getLogger('search');
  const limit = options.limit ?? 200;
  const center = query.location;

  if (!center) return { items: [], companies: [] };

  // A query embedding is only computed when embeddings are configured; without
  // it the matcher simply omits the semantic component.
  const queryEmbedding = isEmbeddingEnabled()
    ? await embedText(
        buildQueryEmbeddingText(query),
        options.signal ? { signal: options.signal } : {},
      )
    : undefined;

  const [jobRows, companyRows] = await Promise.all([
    findJobsWithinRadius({
      center,
      radiusKm: query.radiusKm,
      limit,
      activeOnly: true,
      ...(queryEmbedding ? { queryEmbedding } : {}),
      ...(query.role ? { titleQuery: query.role } : {}),
      ...(query.workModels.length > 0 ? { workModels: query.workModels } : {}),
      ...(query.employmentTypes.length > 0 ? { employmentTypes: query.employmentTypes } : {}),
    }),
    query.includePotentialEmployers
      ? findCompaniesWithinRadius({
          center,
          radiusKm: query.radiusKm,
          limit,
          ...(queryEmbedding ? { queryEmbedding } : {}),
        })
      : Promise.resolve([]),
  ]);

  const companiesById = new Map<string, Company>();
  for (const entry of companyRows) companiesById.set(entry.company.id, entry.company);

  const items: SearchResultItem[] = [];
  const companiesWithJobs = new Set<string>();

  for (const { job, distanceKm, semanticSimilarity } of jobRows) {
    let company = job.companyId ? companiesById.get(job.companyId) : undefined;
    if (!company && job.companyId) {
      company = await getCompanyById(job.companyId);
      if (company) companiesById.set(company.id, company);
    }
    if (job.companyId) companiesWithJobs.add(job.companyId);

    const match = scoreJob(query, job, company, {
      distanceKm,
      // Only present when both the query and the job have embeddings; the
      // matcher drops the component otherwise.
      ...(semanticSimilarity !== undefined ? { semanticSimilarity } : {}),
    });
    if (match.rejected || match.score < query.minMatchScore) continue;

    const item: SearchResultItem = { id: job.id, kind: 'job', match, job };
    if (distanceKm !== undefined) item.distanceKm = distanceKm;
    if (company) item.company = company;
    items.push(item);
  }

  if (query.includePotentialEmployers) {
    for (const { company, distanceKm, semanticSimilarity } of companyRows) {
      // A company with an active vacancy already appears as a job result.
      if (companiesWithJobs.has(company.id) || company.activeJobCount > 0) continue;

      const match = scorePotentialEmployer(query, company, {
        distanceKm,
        ...(semanticSimilarity !== undefined ? { semanticSimilarity } : {}),
      });
      if (match.rejected || match.score < Math.max(query.minMatchScore, 25)) continue;

      items.push({
        id: company.id,
        kind: 'potential_employer',
        match,
        distanceKm,
        company,
      });
    }
  }

  items.sort((a, b) => b.match.score - a.match.score);

  logger.info('Local index search finished', {
    jobs: jobRows.length,
    companies: companyRows.length,
    results: items.length,
  });

  return {
    items: items.slice(0, limit),
    companies: [...companiesById.values()],
  };
}

/** Candidate-mode counterpart of `searchLocalIndex`. */
export async function searchLocalCandidates(
  query: SearchQuery,
  options: LocalSearchOptions = {},
): Promise<SearchResultItem[]> {
  const limit = options.limit ?? 100;
  const center = query.location;

  const rows = await findCandidates({
    ...(center ? { center } : {}),
    radiusKm: query.radiusKm,
    limit,
    ...(query.requiredSkills.length > 0 ? { skills: query.requiredSkills } : {}),
  });

  const items: SearchResultItem[] = [];
  for (const { candidate, distanceKm } of rows) {
    const distance =
      distanceKm ??
      (center && candidate.coordinates ? haversineKm(center, candidate.coordinates) : undefined);

    const match = scoreCandidate(query, candidate, { distanceKm: distance });
    if (match.rejected || match.score < query.minMatchScore) continue;

    const item: SearchResultItem = { id: candidate.id, kind: 'candidate', match, candidate };
    if (distance !== undefined) item.distanceKm = distance;
    items.push(item);
  }

  items.sort((a, b) => b.match.score - a.match.score);
  return items;
}

/** Recomputes a semantic score for one subject against the query embedding. */
export function semanticScoreFor(
  queryEmbedding: readonly number[] | undefined,
  subjectEmbedding: readonly number[] | undefined,
): number | undefined {
  if (!queryEmbedding || !subjectEmbedding) return undefined;
  return similarityScore(queryEmbedding, subjectEmbedding);
}
