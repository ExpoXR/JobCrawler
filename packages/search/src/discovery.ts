import {
  finishCrawlJob,
  getCompanyById,
  isSuppressed,
  refreshActiveJobCount,
  saveSearchResults,
  type SearchResultInput,
  startCrawlJob,
  upsertCandidate,
  upsertCompany,
  upsertJob,
} from '@ejc/database';
import { scoreCandidate, scoreJob, scorePotentialEmployer } from '@ejc/matching';
import { enqueue } from '@ejc/queue';
import {
  careerPageProvider,
  getCandidateProviders,
  getCompanyProviders,
  type DiscoveredCompany,
} from '@ejc/providers';
import {
  AppError,
  type Company,
  getConfig,
  getLogger,
  haversineKm,
  mapLimit,
  type SearchQuery,
} from '@ejc/shared';

import { advanceStage } from './orchestrator';

/**
 * Live discovery (plan section 8).
 *
 * Runs inside workers, in three steps:
 *   1. ask company providers what exists in the radius
 *   2. persist those companies
 *   3. crawl the most promising ones for vacancies
 *
 * Each step is individually failure-tolerant: a dead provider or an unreachable
 * website reduces the result set, it never aborts the search.
 */

function domainOf(website: string | undefined): string | undefined {
  if (!website) return undefined;
  try {
    return new URL(website.startsWith('http') ? website : `https://${website}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return undefined;
  }
}

/** Persists a provider's discovery result, honouring the suppression list. */
async function persistDiscoveredCompany(
  discovered: DiscoveredCompany,
): Promise<Company | undefined> {
  const domain = discovered.domain ?? domainOf(discovered.website);
  if (domain && (await isSuppressed('domain', domain))) return undefined;

  try {
    const company = await upsertCompany({
      name: discovered.name,
      ...(domain ? { domain } : {}),
      ...(discovered.website ? { website: discovered.website } : {}),
      ...(discovered.industry ? { industry: discovered.industry } : {}),
      ...(discovered.address ? { address: discovered.address } : {}),
      ...(discovered.city ? { city: discovered.city } : {}),
      ...(discovered.region ? { region: discovered.region } : {}),
      ...(discovered.country ? { country: discovered.country } : {}),
      ...(discovered.countryCode ? { countryCode: discovered.countryCode } : {}),
      ...(discovered.location ? { location: discovered.location } : {}),
      ...(discovered.publicEmail ? { publicEmail: discovered.publicEmail } : {}),
      ...(discovered.publicPhone ? { publicPhone: discovered.publicPhone } : {}),
      ...(discovered.sourceId ? { osmId: discovered.sourceId } : {}),
    });
    await queueEmbedding('company', company.id);
    return company;
  } catch (error) {
    getLogger('search').debug('Company upsert failed', {
      company: discovered.name,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Queues embedding generation for a freshly written row.
 *
 * Fire-and-forget: embeddings are an enhancement, so a missing Redis must not
 * fail the discovery that produced the row.
 */
async function queueEmbedding(
  subjectType: 'job' | 'company' | 'candidate',
  subjectId: string,
): Promise<void> {
  try {
    await enqueue(
      'embedding',
      { subjectType, subjectId },
      { jobId: `embed:${subjectType}:${subjectId}` },
    );
  } catch {
    // No queue available; the backfill sweep will pick the row up later.
  }
}

export interface DiscoverCompaniesResult {
  companies: Company[];
  errors: string[];
}

/** Step 1 + 2: provider discovery and persistence. */
export async function discoverCompanies(
  searchId: string,
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<DiscoverCompaniesResult> {
  const logger = getLogger('search');
  const config = getConfig();
  const center = query.location;

  if (!center) return { companies: [], errors: ['no-location'] };

  await advanceStage(searchId, 'discovering_companies');

  const providers = await getCompanyProviders();
  const errors: string[] = [];
  const discovered: DiscoveredCompany[] = [];

  for (const provider of providers) {
    if (signal?.aborted) break;
    try {
      const results = await provider.discoverCompanies(
        {
          center,
          radiusKm: query.radiusKm,
          keywords: [query.role, ...query.technologies].filter(Boolean),
          limit: config.crawler.maxDomainsPerSearch * 4,
        },
        { searchId, ...(signal ? { signal } : {}) },
      );
      discovered.push(...results);
    } catch (error) {
      errors.push(provider.info.key);
      logger.warn('Company provider failed', {
        searchId,
        provider: provider.info.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const companies: Company[] = [];
  for (const entry of discovered) {
    const company = await persistDiscoveredCompany(entry);
    if (company) companies.push(company);
  }

  logger.info('Company discovery finished', {
    searchId,
    discovered: discovered.length,
    persisted: companies.length,
  });

  return { companies, errors };
}

/**
 * Chooses which companies are worth a crawl.
 *
 * Crawling is the expensive part of a search, so the budget goes to companies
 * that (a) have a website at all, (b) are closest, and (c) look relevant on the
 * evidence we already have.
 */
export function rankCompaniesForCrawl(
  companies: readonly Company[],
  query: SearchQuery,
  limit: number,
): Company[] {
  const center = query.location;

  const scored = companies
    .filter((company) => Boolean(company.website ?? company.domain))
    .map((company) => {
      const distanceKm =
        center && company.location ? haversineKm(center, company.location) : undefined;
      const match = scorePotentialEmployer(query, company, { distanceKm });

      // Never-crawled companies get a nudge so a search explores new ground.
      const noveltyBonus = company.lastCrawledAt ? 0 : 10;
      return { company, priority: match.score + noveltyBonus };
    })
    .sort((a, b) => b.priority - a.priority);

  return scored.slice(0, limit).map((entry) => entry.company);
}

export interface CrawlCompanyOutcome {
  companyId: string;
  jobsFound: number;
  pagesFetched: number;
  error?: string;
}

/**
 * Step 3: crawl one company's site, persist what it yields, and score the
 * result into the search.
 */
export async function crawlCompanyForJobs(
  searchId: string | undefined,
  company: Company,
  query: SearchQuery | undefined,
  signal?: AbortSignal,
): Promise<CrawlCompanyOutcome> {
  const logger = getLogger('search');
  const website = company.website ?? (company.domain ? `https://${company.domain}` : undefined);

  if (!website) return { companyId: company.id, jobsFound: 0, pagesFetched: 0, error: 'no-website' };

  const crawlJobId = await startCrawlJob({
    ...(searchId ? { searchId } : {}),
    companyId: company.id,
    domain: company.domain ?? new URL(website).hostname,
    startUrl: website,
    queue: 'website-crawl',
  }).catch(() => undefined);

  try {
    const crawl = await careerPageProvider.crawlCompanySite(website, signal ? { signal } : {});

    // Fold crawl findings back into the company record.
    await upsertCompany({
      name: crawl.companyName ?? company.name,
      ...(company.domain ? { domain: company.domain } : { domain: crawl.domain }),
      website: crawl.origin,
      ...(crawl.description ? { description: crawl.description } : {}),
      ...(crawl.careerPageUrl ? { careerPageUrl: crawl.careerPageUrl } : {}),
      ...(crawl.contactPageUrl ? { contactPageUrl: crawl.contactPageUrl } : {}),
      ...(crawl.publicEmail ? { publicEmail: crawl.publicEmail } : {}),
      ...(crawl.publicPhone ? { publicPhone: crawl.publicPhone } : {}),
      ...(crawl.technologies.length > 0 ? { technologies: crawl.technologies } : {}),
      ...(Object.keys(crawl.socialLinks).length > 0 ? { socialLinks: crawl.socialLinks } : {}),
      ...(crawl.sitemapUrls.length > 0 ? { sitemapUrls: crawl.sitemapUrls } : {}),
      markCrawled: true,
    });
    // The crawl added description and technologies, so the vector is stale.
    await queueEmbedding('company', company.id);

    const results: SearchResultInput[] = [];
    let jobsFound = 0;

    for (const page of crawl.pages) {
      for (const extracted of page.jobs) {
        const applicationUrl = extracted.applicationUrl ?? page.url;
        try {
          const { job } = await upsertJob({
            companyId: company.id,
            companyName: extracted.companyName ?? company.name,
            title: extracted.title,
            ...(extracted.description ? { description: extracted.description } : {}),
            ...(extracted.locationText ? { location: extracted.locationText } : {}),
            city: extracted.city ?? company.city,
            region: extracted.region ?? company.region,
            country: extracted.country ?? company.country,
            countryCode: extracted.countryCode ?? company.countryCode,
            coordinates: extracted.coordinates ?? company.location,
            workModel: extracted.workModel,
            employmentType: extracted.employmentType,
            seniority: extracted.seniority,
            ...(extracted.salaryMin !== undefined ? { salaryMin: extracted.salaryMin } : {}),
            ...(extracted.salaryMax !== undefined ? { salaryMax: extracted.salaryMax } : {}),
            ...(extracted.salaryCurrency ? { salaryCurrency: extracted.salaryCurrency } : {}),
            ...(extracted.salaryPeriod ? { salaryPeriod: extracted.salaryPeriod } : {}),
            ...(extracted.requiredExperienceYears !== undefined
              ? { requiredExperienceYears: extracted.requiredExperienceYears }
              : {}),
            languages: extracted.languages,
            skills: extracted.skills,
            applicationUrl,
            canonicalUrl: applicationUrl,
            ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
            ...(extracted.expiresAt ? { expiresAt: extracted.expiresAt } : {}),
            source: {
              provider: careerPageProvider.info.key,
              url: applicationUrl,
              // The employer's own site is always the primary source.
              isPrimary: true,
              raw: { extraction: extracted.extraction, confidence: extracted.confidence },
            },
          });

          jobsFound += 1;
          await queueEmbedding('job', job.id);

          if (searchId && query) {
            const distanceKm =
              query.location && (job.coordinates ?? company.location)
                ? haversineKm(query.location, (job.coordinates ?? company.location)!)
                : undefined;
            const match = scoreJob(query, job, company, { distanceKm });
            if (!match.rejected && match.score >= query.minMatchScore) {
              results.push({
                kind: 'job',
                jobId: job.id,
                match,
                ...(distanceKm !== undefined ? { distanceKm } : {}),
              });
            }
          }
        } catch (error) {
          logger.debug('Job upsert failed', {
            company: company.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    await refreshActiveJobCount(company.id);

    // A company with no vacancy can still be a lead (plan section 18).
    if (searchId && query && jobsFound === 0 && query.includePotentialEmployers) {
      const refreshed = (await getCompanyById(company.id)) ?? company;
      const distanceKm =
        query.location && refreshed.location
          ? haversineKm(query.location, refreshed.location)
          : undefined;
      const match = scorePotentialEmployer(query, refreshed, { distanceKm });
      if (!match.rejected && match.score >= Math.max(query.minMatchScore, 25)) {
        results.push({
          kind: 'potential_employer',
          companyId: refreshed.id,
          match,
          ...(distanceKm !== undefined ? { distanceKm } : {}),
        });
      }
    }

    if (searchId && results.length > 0) await saveSearchResults(searchId, results);

    if (crawlJobId) {
      await finishCrawlJob(crawlJobId, {
        status: 'completed',
        pagesFetched: crawl.pages.length,
        jobsFound,
      });
    }

    return { companyId: company.id, jobsFound, pagesFetched: crawl.pages.length };
  } catch (error) {
    const errorType = error instanceof AppError ? error.type : 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    if (crawlJobId) {
      await finishCrawlJob(crawlJobId, { status: 'failed', errorType, errorMessage: message });
    }
    logger.warn('Company crawl failed', { company: company.name, errorType, message });
    return { companyId: company.id, jobsFound: 0, pagesFetched: 0, error: message };
  }
}

/** Runs the crawl step across the selected companies, with bounded concurrency. */
export async function crawlCompanies(
  searchId: string,
  query: SearchQuery,
  companies: readonly Company[],
  signal?: AbortSignal,
): Promise<CrawlCompanyOutcome[]> {
  const config = getConfig();
  const selected = rankCompaniesForCrawl(companies, query, config.crawler.maxDomainsPerSearch);

  await advanceStage(searchId, 'checking_company_websites', {
    message: `Checking ${selected.length} company websites`,
  });

  const outcomes = await mapLimit(selected, Math.max(1, Math.floor(config.worker.concurrency / 2)), (company) =>
    crawlCompanyForJobs(searchId, company, query, signal),
  );

  await advanceStage(searchId, 'extracting_jobs', {
    message: `Extracted ${outcomes.reduce((sum, entry) => sum + entry.jobsFound, 0)} vacancies`,
  });

  return outcomes;
}

/** Candidate-mode discovery (plan section 12). */
export async function discoverCandidates(
  searchId: string,
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<number> {
  const logger = getLogger('search');
  await advanceStage(searchId, 'searching_profiles');

  const providers = await getCandidateProviders();
  const results: SearchResultInput[] = [];

  for (const provider of providers) {
    if (signal?.aborted) break;
    try {
      const discovered = await provider.searchCandidates(
        { query, limit: 25 },
        { searchId, ...(signal ? { signal } : {}) },
      );

      for (const entry of discovered) {
        const candidate = await upsertCandidate({
          profileUrl: entry.profileUrl,
          ...(entry.publicName ? { publicName: entry.publicName } : {}),
          ...(entry.publicTitle ? { publicTitle: entry.publicTitle } : {}),
          ...(entry.approximateLocation
            ? { approximateLocation: entry.approximateLocation }
            : {}),
          ...(entry.skills ? { skills: entry.skills } : {}),
          ...(entry.technologies ? { technologies: entry.technologies } : {}),
          ...(entry.portfolioUrl ? { portfolioUrl: entry.portfolioUrl } : {}),
          ...(entry.githubUrl ? { githubUrl: entry.githubUrl } : {}),
          source: { provider: entry.provider, url: entry.profileUrl },
        });
        if (!candidate) continue;
        await queueEmbedding('candidate', candidate.id);

        const distanceKm =
          query.location && candidate.coordinates
            ? haversineKm(query.location, candidate.coordinates)
            : undefined;
        const match = scoreCandidate(query, candidate, { distanceKm });
        if (match.rejected || match.score < query.minMatchScore) continue;

        results.push({
          kind: 'candidate',
          candidateId: candidate.id,
          match,
          ...(distanceKm !== undefined ? { distanceKm } : {}),
        });
      }
    } catch (error) {
      logger.warn('Candidate provider failed', {
        searchId,
        provider: provider.info.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (results.length > 0) await saveSearchResults(searchId, results);
  return results.length;
}
