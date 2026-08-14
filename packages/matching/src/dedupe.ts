import {
  cosineSimilarity,
  type Job,
  normalizeCompanyName,
  normalizeJobTitle,
  trigramSimilarity,
} from '@ejc/shared';

/**
 * Duplicate detection (plan section 17).
 *
 * The same vacancy typically appears on the employer's site, on LinkedIn, on
 * Indeed and on two aggregators. This module decides whether two records are
 * the same logical job, and which source should own the application link.
 */

export interface DuplicateSignals {
  sameCanonicalUrl: boolean;
  companySimilarity: number;
  titleSimilarity: number;
  sameCity: boolean;
  descriptionSimilarity: number;
  semanticSimilarity?: number;
  publishedWithinDays?: number;
}

export interface DuplicateVerdict {
  isDuplicate: boolean;
  confidence: number;
  signals: DuplicateSignals;
  reason: string;
}

function canonicalUrlKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    // Tracking parameters differ between aggregators for the same posting.
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|ref|source|src|gh_src|trk)/i.test(key)) parsed.searchParams.delete(key);
    }
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path}${parsed.search}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function daysBetween(a: string | undefined, b: string | undefined): number | undefined {
  if (!a || !b) return undefined;
  const first = new Date(a).getTime();
  const second = new Date(b).getTime();
  if (Number.isNaN(first) || Number.isNaN(second)) return undefined;
  return Math.abs(first - second) / 86_400_000;
}

export interface DuplicateOptions {
  /** Embeddings for the two jobs, when available. */
  embeddings?: [readonly number[], readonly number[]];
  titleThreshold?: number;
  descriptionThreshold?: number;
}

/**
 * Compares two jobs.
 *
 * An identical canonical URL is conclusive. Otherwise the decision needs
 * agreement across independent signals — same employer *and* near-identical
 * title *and* the same city — because titles alone repeat constantly
 * ("Frontend Developer" exists at every agency in town).
 */
export function compareJobs(a: Job, b: Job, options: DuplicateOptions = {}): DuplicateVerdict {
  const titleThreshold = options.titleThreshold ?? 0.82;
  const descriptionThreshold = options.descriptionThreshold ?? 0.7;

  const urlA = canonicalUrlKey(a.applicationUrl ?? a.sources[0]?.url);
  const urlB = canonicalUrlKey(b.applicationUrl ?? b.sources[0]?.url);
  const sameCanonicalUrl = Boolean(urlA && urlB && urlA === urlB);

  const companySimilarity =
    a.companyName && b.companyName
      ? trigramSimilarity(normalizeCompanyName(a.companyName), normalizeCompanyName(b.companyName))
      : a.companyId && a.companyId === b.companyId
        ? 1
        : 0;

  const titleSimilarity = trigramSimilarity(
    normalizeJobTitle(a.title),
    normalizeJobTitle(b.title),
  );

  const sameCity =
    Boolean(a.city && b.city) && a.city?.toLowerCase().trim() === b.city?.toLowerCase().trim();

  const descriptionSimilarity =
    a.description && b.description
      ? trigramSimilarity(a.description.slice(0, 2000), b.description.slice(0, 2000))
      : 0;

  const signals: DuplicateSignals = {
    sameCanonicalUrl,
    companySimilarity,
    titleSimilarity,
    sameCity,
    descriptionSimilarity,
  };

  if (options.embeddings) {
    signals.semanticSimilarity = cosineSimilarity(options.embeddings[0], options.embeddings[1]);
  }
  const publishedGap = daysBetween(a.publishedAt, b.publishedAt);
  if (publishedGap !== undefined) signals.publishedWithinDays = publishedGap;

  if (sameCanonicalUrl) {
    return { isDuplicate: true, confidence: 1, signals, reason: 'Identical canonical URL' };
  }

  const sameEmployer = companySimilarity >= 0.85 || (a.companyId && a.companyId === b.companyId);
  if (!sameEmployer) {
    return { isDuplicate: false, confidence: 0, signals, reason: 'Different employer' };
  }

  const titlesAgree = titleSimilarity >= titleThreshold;
  const bodiesAgree = descriptionSimilarity >= descriptionThreshold;
  const semanticAgrees = (signals.semanticSimilarity ?? 0) >= 0.93;
  const locationAgrees = sameCity || !a.city || !b.city;

  if (titlesAgree && locationAgrees) {
    const confidence = Math.min(1, 0.6 + titleSimilarity * 0.3 + (bodiesAgree ? 0.1 : 0));
    return { isDuplicate: true, confidence, signals, reason: 'Same employer, title and location' };
  }

  if ((bodiesAgree || semanticAgrees) && locationAgrees) {
    return {
      isDuplicate: true,
      confidence: 0.75,
      signals,
      reason: 'Same employer and near-identical description',
    };
  }

  return { isDuplicate: false, confidence: 0, signals, reason: 'Insufficient agreement' };
}

/** Employer-hosted URLs outrank aggregator URLs as the application link. */
const AGGREGATOR_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'stepstone.de',
  'xing.com',
  'glassdoor.com',
  'monster.de',
  'jobs.de',
  'stellenanzeigen.de',
  'arbeitsagentur.de',
  'greenhouse.io',
  'lever.co',
  'personio.de',
  'workday.com',
  'smartrecruiters.com',
];

export function isAggregatorUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return AGGREGATOR_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`));
  } catch {
    return false;
  }
}

/**
 * Picks the application URL for a merged job: the employer's own page when we
 * have one, otherwise the first source we saw.
 */
export function preferredApplicationUrl(
  sources: readonly { url: string; provider?: string }[],
  companyDomain?: string,
): string | undefined {
  if (sources.length === 0) return undefined;

  if (companyDomain) {
    const ownDomain = sources.find((source) => {
      try {
        const host = new URL(source.url).hostname.replace(/^www\./, '').toLowerCase();
        const target = companyDomain.replace(/^www\./, '').toLowerCase();
        return host === target || host.endsWith(`.${target}`);
      } catch {
        return false;
      }
    });
    if (ownDomain) return ownDomain.url;
  }

  const nonAggregator = sources.find((source) => !isAggregatorUrl(source.url));
  return (nonAggregator ?? sources[0])?.url;
}

/**
 * Collapses a list of jobs into logical jobs, keeping every source URL.
 *
 * O(n²) by design: the input is one search's results (hundreds, not millions),
 * and a blocking key would risk missing cross-provider variants.
 */
export function dedupeJobs(jobs: readonly Job[]): Array<{ job: Job; merged: Job[] }> {
  const groups: Array<{ job: Job; merged: Job[] }> = [];

  for (const job of jobs) {
    const group = groups.find((candidate) => compareJobs(candidate.job, job).isDuplicate);
    if (!group) {
      groups.push({ job, merged: [] });
      continue;
    }

    group.merged.push(job);

    const sources = [...group.job.sources, ...job.sources];
    const seen = new Set<string>();
    group.job.sources = sources.filter((source) => {
      if (seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    });

    // Keep the richest description and the earliest publication date.
    if ((job.description?.length ?? 0) > (group.job.description?.length ?? 0)) {
      group.job.description = job.description;
    }
    if (job.publishedAt && (!group.job.publishedAt || job.publishedAt < group.job.publishedAt)) {
      group.job.publishedAt = job.publishedAt;
    }
    group.job.skills = [...new Set([...group.job.skills, ...job.skills])];

    const applicationUrl = preferredApplicationUrl(group.job.sources);
    if (applicationUrl) group.job.applicationUrl = applicationUrl;
  }

  return groups;
}
