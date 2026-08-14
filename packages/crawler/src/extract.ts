import {
  canonicalizeSkills,
  classifyUrlPath,
  extractSkills,
  type PageCategory,
  sanitizeScrapedText,
} from '@ejc/shared';
import * as cheerio from 'cheerio';

/**
 * HTML extraction.
 *
 * Scraped HTML is untrusted input (plan section 37): nothing here is ever
 * re-emitted as markup. Every string that leaves this module is plain text run
 * through `sanitizeScrapedText`, and URLs are resolved against the page's own
 * base so relative links cannot escape to unexpected origins unnoticed.
 */

export interface ExtractedLink {
  url: string;
  text: string;
  category: PageCategory;
  score: number;
}

export interface ExtractedPage {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  language?: string;
  text: string;
  headings: string[];
  links: ExtractedLink[];
  jsonLdBlocks: unknown[];
  emails: string[];
  phones: string[];
  socialLinks: Record<string, string>;
  skills: string[];
}

const SOCIAL_HOSTS: Record<string, string> = {
  'linkedin.com': 'linkedin',
  'xing.com': 'xing',
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'youtube.com': 'youtube',
  'mastodon.social': 'mastodon',
  'bsky.app': 'bluesky',
};

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_PATTERN = /(?:\+|00)[\d][\d\s()./-]{6,20}\d/g;

function resolveUrl(href: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function socialKeyFor(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    for (const [domain, key] of Object.entries(SOCIAL_HOSTS)) {
      if (host === domain || host.endsWith(`.${domain}`)) return key;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Parses a page into the structured pieces the rest of the system consumes. */
export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const $ = cheerio.load(html);

  // Structured data must be read before the script tags are stripped below.
  const jsonLdBlocks: unknown[] = [];
  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).text().trim();
    if (!raw || raw.length > 500_000) return;
    try {
      jsonLdBlocks.push(JSON.parse(raw));
    } catch {
      // Invalid structured data is common; ignore it rather than fail.
    }
  });

  // Script/style/nav chrome would otherwise dominate the extracted text.
  $('script, style, noscript, svg, iframe, template').remove();

  // `.text()` concatenates without separators, so `<h2>Wir bieten</h2><p>Hybrid`
  // would come out as "bietenHybrid" and defeat every keyword match downstream.
  // Padding block elements restores the word boundaries.
  $('br').replaceWith(' ');
  $(
    'p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6, section, article, header, footer, nav, aside, blockquote, pre, figcaption, dt, dd, option',
  ).append(' ');

  const title = sanitizeScrapedText($('title').first().text(), 300) || undefined;
  const description =
    sanitizeScrapedText(
      $('meta[name="description"]').attr('content') ??
        $('meta[property="og:description"]').attr('content') ??
        '',
      600,
    ) || undefined;

  const canonicalHref = $('link[rel="canonical"]').attr('href');
  const canonicalUrl = canonicalHref ? resolveUrl(canonicalHref, baseUrl) : undefined;
  const language = $('html').attr('lang')?.slice(0, 5).toLowerCase();

  const headings: string[] = [];
  $('h1, h2, h3').each((_index, element) => {
    const text = sanitizeScrapedText($(element).text(), 200);
    if (text) headings.push(text);
  });

  const seenLinks = new Set<string>();
  const links: ExtractedLink[] = [];
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || seenLinks.has(resolved)) return;
    seenLinks.add(resolved);
    const { category, score } = classifyUrlPath(resolved);
    links.push({
      url: resolved,
      text: sanitizeScrapedText($(element).text(), 160),
      category,
      score,
    });
  });

  const bodyText = sanitizeScrapedText($('body').text(), 60_000);

  const emails = [
    ...new Set(
      (bodyText.match(EMAIL_PATTERN) ?? [])
        .map((email) => email.toLowerCase())
        .filter((email) => !email.endsWith('.png') && !email.endsWith('.jpg')),
    ),
  ].slice(0, 10);

  const phones = [
    ...new Set((bodyText.match(PHONE_PATTERN) ?? []).map((phone) => phone.replace(/\s+/g, ' ').trim())),
  ].slice(0, 5);

  const socialLinks: Record<string, string> = {};
  for (const link of links) {
    const key = socialKeyFor(link.url);
    if (key && !socialLinks[key]) socialLinks[key] = link.url;
  }

  const page: ExtractedPage = {
    text: bodyText,
    headings: headings.slice(0, 60),
    links: links.slice(0, 500),
    jsonLdBlocks,
    emails,
    phones,
    socialLinks,
    skills: canonicalizeSkills(extractSkills(`${title ?? ''} ${headings.join(' ')} ${bodyText}`)),
  };

  if (title) page.title = title;
  if (description) page.description = description;
  if (canonicalUrl) page.canonicalUrl = canonicalUrl;
  if (language) page.language = language;

  return page;
}

/**
 * Picks the most promising career/job URLs from a page's links.
 *
 * Same-origin only: following off-site links would turn a bounded company crawl
 * into an unbounded web crawl.
 */
export function selectRelevantLinks(
  page: ExtractedPage,
  baseUrl: string,
  limit: number,
): ExtractedLink[] {
  let baseHost: string;
  try {
    baseHost = new URL(baseUrl).hostname.replace(/^www\./, '');
  } catch {
    return [];
  }

  return page.links
    .filter((link) => {
      try {
        return new URL(link.url).hostname.replace(/^www\./, '') === baseHost;
      } catch {
        return false;
      }
    })
    .filter((link) => link.category === 'career' || link.category === 'job')
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Best-effort company name from a page's metadata. */
export function extractCompanyName(page: ExtractedPage, hostname: string): string {
  const fromTitle = page.title?.split(/[|\-–—:]/)[0]?.trim();
  if (fromTitle && fromTitle.length >= 2 && fromTitle.length <= 80) return fromTitle;

  const bare = hostname.replace(/^www\./, '').split('.')[0] ?? hostname;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}
