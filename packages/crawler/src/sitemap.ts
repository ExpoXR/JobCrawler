import { AppError, getConfig } from '@ejc/shared';
import { XMLParser } from 'fast-xml-parser';

import { tryFetch } from './fetcher';
import { parseRobotsTxt } from './robots';

/**
 * Sitemap discovery and parsing (plan section 9).
 *
 * Sitemaps are the polite way to find a site's job pages: one XML fetch instead
 * of a blind crawl. Sitemap indexes are followed one level deep, and the total
 * number of URLs is capped so a hostile or huge sitemap cannot blow up a search.
 */

export interface SitemapEntry {
  url: string;
  lastModified?: string;
  priority?: number;
}

/**
 * XML parsing is a known attack surface (plan section 37): entity expansion is
 * off, and the parser never resolves external references.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  parseTagValue: false,
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && '#text' in value) {
    const text = (value as { '#text': unknown })['#text'];
    if (typeof text === 'string') return text.trim();
  }
  return undefined;
}

export interface ParsedSitemap {
  entries: SitemapEntry[];
  /** Child sitemap URLs, when the document is a sitemap index. */
  indexUrls: string[];
}

export function parseSitemapXml(xml: string, limit = 5000): ParsedSitemap {
  let document: Record<string, unknown>;
  try {
    document = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new AppError('invalid_xml', 'Sitemap is not valid XML', { cause: error });
  }

  const entries: SitemapEntry[] = [];
  const indexUrls: string[] = [];

  const sitemapIndex = document['sitemapindex'] as Record<string, unknown> | undefined;
  if (sitemapIndex) {
    for (const node of asArray(sitemapIndex['sitemap'] as Record<string, unknown>[] | undefined)) {
      const loc = textOf(node?.['loc']);
      if (loc) indexUrls.push(loc);
      if (indexUrls.length >= 100) break;
    }
  }

  const urlset = document['urlset'] as Record<string, unknown> | undefined;
  if (urlset) {
    for (const node of asArray(urlset['url'] as Record<string, unknown>[] | undefined)) {
      const loc = textOf(node?.['loc']);
      if (!loc) continue;
      const entry: SitemapEntry = { url: loc };
      const lastMod = textOf(node?.['lastmod']);
      if (lastMod) entry.lastModified = lastMod;
      const priority = Number(textOf(node?.['priority']) ?? Number.NaN);
      if (Number.isFinite(priority)) entry.priority = priority;
      entries.push(entry);
      if (entries.length >= limit) break;
    }
  }

  if (!sitemapIndex && !urlset) {
    throw new AppError('invalid_xml', 'Document is neither a urlset nor a sitemapindex');
  }

  return { entries, indexUrls };
}

/** Plain-text sitemaps (one URL per line) are rare but legal. */
export function parseTextSitemap(body: string, limit = 5000): SitemapEntry[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('http://') || line.startsWith('https://'))
    .slice(0, limit)
    .map((url) => ({ url }));
}

export interface DiscoverSitemapsOptions {
  /** Sitemap URLs already known from robots.txt. */
  knownSitemaps?: string[];
  maxEntries?: number;
  signal?: AbortSignal;
}

const CONVENTIONAL_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

/**
 * Finds sitemap URLs for an origin: robots.txt first, then the conventional
 * locations. Returns the URLs only — fetching them is a separate step.
 */
export async function discoverSitemapUrls(
  origin: string,
  options: DiscoverSitemapsOptions = {},
): Promise<string[]> {
  const found = new Set<string>(options.knownSitemaps ?? []);

  if (found.size === 0) {
    const robotsUrl = new URL('/robots.txt', origin).toString();
    const fetchOptions: Parameters<typeof tryFetch>[1] = {
      allowedContentTypes: ['text/plain', 'text/html'],
    };
    if (options.signal) fetchOptions.signal = options.signal;
    const response = await tryFetch(robotsUrl, fetchOptions);
    if (response) {
      for (const sitemap of parseRobotsTxt(response.body).sitemaps) {
        try {
          found.add(new URL(sitemap, origin).toString());
        } catch {
          // A malformed Sitemap: line is not worth failing the crawl over.
        }
      }
    }
  }

  if (found.size === 0) {
    for (const path of CONVENTIONAL_PATHS) {
      found.add(new URL(path, origin).toString());
    }
  }

  return [...found];
}

export interface FetchSitemapOptions {
  maxEntries?: number;
  /** How many child sitemaps of an index to follow. */
  maxChildSitemaps?: number;
  signal?: AbortSignal;
}

/**
 * Fetches sitemap URLs and returns their entries, following one level of
 * sitemap index. Failures are swallowed per-sitemap: a broken child must not
 * discard the entries we already have.
 */
export async function fetchSitemapEntries(
  sitemapUrls: readonly string[],
  options: FetchSitemapOptions = {},
): Promise<SitemapEntry[]> {
  const config = getConfig();
  const maxEntries = options.maxEntries ?? config.crawler.maxSitemapEntries;
  const maxChildSitemaps = options.maxChildSitemaps ?? 10;

  const entries: SitemapEntry[] = [];
  const seenUrls = new Set<string>();
  const queue = [...sitemapUrls];
  let childBudget = maxChildSitemaps;

  while (queue.length > 0 && entries.length < maxEntries) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenUrls.has(sitemapUrl)) continue;
    seenUrls.add(sitemapUrl);

    const fetchOptions: Parameters<typeof tryFetch>[1] = {
      allowedContentTypes: ['text/xml', 'application/xml', 'text/plain', 'text/html'],
    };
    if (options.signal) fetchOptions.signal = options.signal;
    const response = await tryFetch(sitemapUrl, fetchOptions);
    if (!response) continue;

    const trimmed = response.body.trimStart();
    if (!trimmed.startsWith('<')) {
      for (const entry of parseTextSitemap(response.body, maxEntries - entries.length)) {
        entries.push(entry);
      }
      continue;
    }

    try {
      const parsed = parseSitemapXml(response.body, maxEntries - entries.length);
      entries.push(...parsed.entries);
      for (const childUrl of parsed.indexUrls) {
        if (childBudget <= 0) break;
        childBudget -= 1;
        queue.push(childUrl);
      }
    } catch {
      // Invalid XML: skip this sitemap, keep whatever else we found.
    }
  }

  return entries.slice(0, maxEntries);
}
