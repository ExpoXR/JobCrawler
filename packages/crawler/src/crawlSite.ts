import { getRobotsCache, setRobotsCache } from '@ejc/database';
import {
  AppError,
  classifyError,
  classifyUrlPath,
  getConfig,
  getLogger,
  type PageCategory,
  sleep,
} from '@ejc/shared';

import { extractCompanyName, extractPage, type ExtractedPage, selectRelevantLinks } from './extract';
import { safeFetch, tryFetch } from './fetcher';
import { extractJobFromHtml, extractJobsFromJsonLd, type ExtractedJob } from './jobPosting';
import { isPathAllowed, parseRobotsTxt, type RobotsTxt } from './robots';
import { discoverSitemapUrls, fetchSitemapEntries } from './sitemap';
import { assertUrlIsSafe } from './ssrf';

/**
 * Bounded, polite crawl of a single company website (plan sections 9 and 10).
 *
 * Order of operations, deliberately:
 *   robots.txt → sitemap → URL classification → selected pages only
 *
 * The crawler never walks a whole site. When there is no sitemap it falls back
 * to the homepage's own career links, one level deep, still respecting the
 * per-domain page budget.
 */

export interface CrawlSiteOptions {
  maxPages?: number;
  maxSitemapEntries?: number;
  /** Overrides robots.txt Crawl-delay when that is absent. */
  delayMs?: number;
  respectRobots?: boolean;
  signal?: AbortSignal;
  companyId?: string;
  /** Called after every fetched page so callers can stream progress. */
  onPage?: (page: CrawledPageResult) => void | Promise<void>;
}

export interface CrawledPageResult {
  url: string;
  category: PageCategory;
  page: ExtractedPage;
  jobs: ExtractedJob[];
  statusCode: number;
  durationMs: number;
  byteSize: number;
}

export interface CrawlSiteResult {
  domain: string;
  origin: string;
  companyName?: string;
  description?: string;
  careerPageUrl?: string;
  contactPageUrl?: string;
  publicEmail?: string;
  publicPhone?: string;
  socialLinks: Record<string, string>;
  technologies: string[];
  sitemapUrls: string[];
  pages: CrawledPageResult[];
  jobs: ExtractedJob[];
  /** Non-fatal problems; one failed page never fails the crawl. */
  errors: Array<{ url: string; errorType: string; message: string }>;
  robotsBlocked: boolean;
}

/** Loads and parses robots.txt. Absent or broken means "crawl allowed". */
/** How long a fetched robots.txt stays good for. */
const ROBOTS_CACHE_HOURS = 24;

/**
 * Fetches `/robots.txt`, or reuses a recent copy.
 *
 * Politeness is the point: without the cache, crawling twenty companies for one
 * search means twenty robots.txt requests, and re-running the search means
 * twenty more. `robots_cache` has existed since migration 0005 with nothing
 * reading it.
 *
 * A cache failure is never fatal — a crawl that cannot reach Postgres should
 * still fetch robots.txt and obey it, rather than refusing to run.
 */
async function loadRobots(
  origin: string,
  domain: string,
  signal?: AbortSignal,
): Promise<{ robots: RobotsTxt; serverError: boolean }> {
  const cached = await getRobotsCache(domain).catch(() => undefined);
  if (cached) {
    // A cached 5xx keeps meaning "assume disallowed" until it expires; that is
    // what stops a struggling host being re-probed on every search.
    const serverError = cached.statusCode !== null && cached.statusCode >= 500;
    return { robots: parseRobotsTxt(cached.body ?? ''), serverError };
  }

  const robotsUrl = new URL('/robots.txt', origin).toString();
  try {
    const options: Parameters<typeof safeFetch>[1] = {
      allowedContentTypes: ['text/plain', 'text/html'],
      maxBytes: 512_000,
    };
    if (signal) options.signal = signal;
    const response = await safeFetch(robotsUrl, options);

    const robots = parseRobotsTxt(response.body);
    await setRobotsCache({
      domain,
      body: response.body,
      crawlDelayMs: null,
      statusCode: response.status,
      ttlHours: ROBOTS_CACHE_HOURS,
    }).catch(() => undefined);

    return { robots, serverError: false };
  } catch (error) {
    const type = classifyError(error);
    // 5xx on robots.txt means "assume disallowed" per RFC 9309.
    const serverError = type === 'http_server' || type === 'rate_limited';

    await setRobotsCache({
      domain,
      body: null,
      crawlDelayMs: null,
      statusCode: serverError ? 503 : 404,
      ttlHours: serverError ? 1 : ROBOTS_CACHE_HOURS,
    }).catch(() => undefined);

    return { robots: { groups: [], sitemaps: [] }, serverError };
  }
}

function rank(category: PageCategory): number {
  switch (category) {
    case 'job':
      return 0;
    case 'career':
      return 1;
    case 'company':
      return 2;
    case 'contact':
      return 3;
    default:
      return 4;
  }
}

export async function crawlSite(
  websiteUrl: string,
  options: CrawlSiteOptions = {},
): Promise<CrawlSiteResult> {
  const config = getConfig();
  const logger = getLogger('crawler');

  const maxPages = options.maxPages ?? config.crawler.maxPagesPerDomain;
  const respectRobots = options.respectRobots ?? config.crawler.respectRobots;

  const guarded = await assertUrlIsSafe(websiteUrl, {
    allowPrivateAddresses: config.crawler.allowPrivateAddresses,
    blockedDomains: config.crawler.blockedDomains,
  });
  const origin = guarded.url.origin;
  const domain = guarded.hostname;

  const result: CrawlSiteResult = {
    domain,
    origin,
    socialLinks: {},
    technologies: [],
    sitemapUrls: [],
    pages: [],
    jobs: [],
    errors: [],
    robotsBlocked: false,
  };

  const { robots, serverError } = respectRobots
    ? await loadRobots(origin, domain, options.signal)
    : { robots: { groups: [], sitemaps: [] } as RobotsTxt, serverError: false };

  if (serverError) {
    result.robotsBlocked = true;
    result.errors.push({
      url: `${origin}/robots.txt`,
      errorType: 'blocked_by_robots',
      message: 'robots.txt returned a server error; treating the site as disallowed',
    });
    return result;
  }

  const homepageDecision = isPathAllowed(
    robots,
    config.crawler.userAgent,
    '/',
    config.crawler.defaultDelayMs,
  );
  const delayMs = Math.max(options.delayMs ?? 0, homepageDecision.crawlDelayMs);

  const allowed = (url: string): boolean => {
    if (!respectRobots) return true;
    try {
      const { pathname, search } = new URL(url);
      return isPathAllowed(robots, config.crawler.userAgent, `${pathname}${search}`, delayMs)
        .allowed;
    } catch {
      return false;
    }
  };

  // 1. Sitemap-first discovery.
  const sitemapUrls = await discoverSitemapUrls(origin, {
    ...(robots.sitemaps.length > 0 ? { knownSitemaps: robots.sitemaps } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  result.sitemapUrls = sitemapUrls;

  const sitemapEntries = await fetchSitemapEntries(sitemapUrls, {
    maxEntries: options.maxSitemapEntries ?? config.crawler.maxSitemapEntries,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // 2. Classify and rank candidate URLs; the homepage is always included.
  const candidates = new Map<string, PageCategory>();
  candidates.set(origin.endsWith('/') ? origin : `${origin}/`, 'company');

  for (const entry of sitemapEntries) {
    if (candidates.size > 2000) break;
    let sameOrigin: boolean;
    try {
      sameOrigin = new URL(entry.url).hostname.replace(/^www\./, '') === domain.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (!sameOrigin) continue;
    const { category } = classifyUrlPath(entry.url);
    if (category === 'other') continue;
    candidates.set(entry.url, category);
  }

  const ordered = [...candidates.entries()]
    .sort(([, a], [, b]) => rank(a) - rank(b))
    .slice(0, maxPages);

  const visited = new Set<string>();
  let usedFallback = false;

  const fetchAndExtract = async (url: string, category: PageCategory): Promise<void> => {
    if (visited.has(url) || result.pages.length >= maxPages) return;
    visited.add(url);

    if (!allowed(url)) {
      result.errors.push({
        url,
        errorType: 'blocked_by_robots',
        message: 'Disallowed by robots.txt',
      });
      return;
    }

    try {
      const fetchOptions: Parameters<typeof safeFetch>[1] = {};
      if (options.signal) fetchOptions.signal = options.signal;
      const response = await safeFetch(url, fetchOptions);
      const page = extractPage(response.body, response.finalUrl);

      const jsonLdJobs = extractJobsFromJsonLd(page);
      const jobs =
        jsonLdJobs.length > 0
          ? jsonLdJobs
          : [extractJobFromHtml(page, response.finalUrl)].filter(
              (job): job is ExtractedJob => job !== undefined,
            );

      const pageResult: CrawledPageResult = {
        url: response.finalUrl,
        category,
        page,
        jobs,
        statusCode: response.status,
        durationMs: response.durationMs,
        byteSize: response.byteSize,
      };
      result.pages.push(pageResult);
      result.jobs.push(...jobs);
      await options.onPage?.(pageResult);
    } catch (error) {
      const errorType = error instanceof AppError ? error.type : classifyError(error);
      result.errors.push({
        url,
        errorType,
        message: error instanceof Error ? error.message : String(error),
      });
      logger.debug('Page crawl failed', { url, domain, errorType });
    }

    if (delayMs > 0 && result.pages.length < maxPages) {
      await sleep(delayMs, options.signal).catch(() => undefined);
    }
  };

  for (const [url, category] of ordered) {
    if (result.pages.length >= maxPages) break;
    await fetchAndExtract(url, category);
  }

  // 3. No sitemap-derived career pages? Follow the homepage's own links, once.
  const foundCareerPage = result.pages.some(
    (page) => page.category === 'career' || page.category === 'job',
  );
  if (!foundCareerPage && result.pages.length < maxPages) {
    usedFallback = true;
    const homepage = result.pages[0];
    if (homepage) {
      const links = selectRelevantLinks(homepage.page, origin, maxPages - result.pages.length);
      for (const link of links) {
        if (result.pages.length >= maxPages) break;
        await fetchAndExtract(link.url, link.category);
      }
    }
  }

  // 4. Fold page-level findings into company-level fields.
  const homepage = result.pages[0];
  if (homepage) {
    result.companyName = extractCompanyName(homepage.page, domain);
    if (homepage.page.description) result.description = homepage.page.description;
  }

  for (const page of result.pages) {
    for (const [key, url] of Object.entries(page.page.socialLinks)) {
      result.socialLinks[key] ??= url;
    }
    for (const skill of page.page.skills) {
      if (!result.technologies.includes(skill)) result.technologies.push(skill);
    }
    if (!result.publicEmail && page.page.emails[0]) result.publicEmail = page.page.emails[0];
    if (!result.publicPhone && page.page.phones[0]) result.publicPhone = page.page.phones[0];
    if (!result.careerPageUrl && (page.category === 'career' || page.category === 'job')) {
      result.careerPageUrl = page.url;
    }
    if (!result.contactPageUrl && page.category === 'contact') result.contactPageUrl = page.url;
  }

  logger.info('Site crawl finished', {
    domain,
    pages: result.pages.length,
    jobsFound: result.jobs.length,
    errors: result.errors.length,
    usedFallback,
  });

  return result;
}

/**
 * Re-checks a single job URL (plan section 32).
 *
 * A 404/410 means the vacancy is gone; anything else (timeout, 429, 5xx) is
 * inconclusive and must not mark the job inactive.
 */
export async function verifyJobUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ stillPresent: boolean; conclusive: boolean; statusCode?: number }> {
  try {
    const options: Parameters<typeof safeFetch>[1] = {};
    if (signal) options.signal = signal;
    const response = await safeFetch(url, options);
    const page = extractPage(response.body, response.finalUrl);
    const stillPresent =
      extractJobsFromJsonLd(page).length > 0 || extractJobFromHtml(page, response.finalUrl) !== undefined;
    return { stillPresent, conclusive: true, statusCode: response.status };
  } catch (error) {
    const type = error instanceof AppError ? error.type : classifyError(error);
    if (type === 'not_found') return { stillPresent: false, conclusive: true, statusCode: 404 };
    return { stillPresent: true, conclusive: false };
  }
}

/** Probes a domain for a reachable website, trying https then http. */
export async function resolveWebsite(domain: string): Promise<string | undefined> {
  for (const candidate of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    const response = await tryFetch(candidate, { maxBytes: 200_000 });
    if (response) return new URL(response.finalUrl).origin;
  }
  return undefined;
}
