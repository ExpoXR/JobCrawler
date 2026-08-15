# Crawler

The crawler is deliberately narrow: it visits a bounded set of pages on a
company's own website, and it never walks a whole site.

## Order of operations

```text
website URL
    │
    ├─ SSRF guard (shape + resolved IP)
    ├─ robots.txt        → group selection, Allow/Disallow, Crawl-delay
    ├─ sitemap discovery → robots Sitemap: lines, else /sitemap.xml et al.
    ├─ sitemap fetch     → one level of sitemap index, entry-capped
    ├─ URL classification→ job > career > company > contact > other
    ├─ fetch selected pages only, in rank order, up to the page budget
    │     └─ per page: JSON-LD JobPosting, else heuristic extraction
    └─ fold page findings into company-level fields
```

If no sitemap yields a career page, the crawler falls back to the homepage's own
same-origin career links — one level deep, still inside the page budget.

Implemented in `packages/crawler/src/crawlSite.ts`.

## Politeness

- `robots.txt` is parsed per RFC 9309: longest-match Allow/Disallow with `*`
  and `$`, most-specific user-agent group, empty `Disallow:` means allow-all.
- A **5xx on robots.txt means the whole site is treated as disallowed**, per the
  RFC. A 404 means allowed.
- `Crawl-delay` is honoured; `CRAWL_DEFAULT_DELAY_MS` (1 s) applies otherwise.
- Responses are cached in `crawled_pages` with a TTL, and robots decisions in
  `robots_cache`, so a re-run does not re-fetch.
- The User-Agent identifies the deployment and carries a contact address.
  Set `CRAWLER_USER_AGENT` and `CRAWLER_CONTACT_EMAIL` before crawling anything
  you do not own.

The crawler never attempts to bypass CAPTCHAs, authentication, bot protection,
paywalls or rate limiting. A source that does not want to be read is not read.

## Limits

Every limit is configurable (plan section 36) and enforced in `safeFetch` /
`crawlSite`:

| Setting | Default | Effect |
| --- | --- | --- |
| `CRAWL_MAX_DOMAINS_PER_SEARCH` | 25 | Companies crawled per search |
| `CRAWL_MAX_PAGES_PER_DOMAIN` | 15 | Pages fetched per site |
| `CRAWL_MAX_SITEMAP_ENTRIES` | 2000 | Sitemap URLs considered |
| `CRAWL_MAX_PAGE_BYTES` | 2 MB | Response cap, enforced while streaming |
| `CRAWL_TIMEOUT_MS` | 15000 | Per-request timeout |
| `CRAWL_MAX_REDIRECTS` | 5 | Redirect hops, each re-validated |
| `CRAWL_DEFAULT_DELAY_MS` | 1000 | Delay when robots.txt sets none |

The byte cap is applied *while reading the stream*, not from `Content-Length`,
so a server that lies about its size still cannot exhaust memory.

## URL classification

`classifyUrlPath` (in `packages/shared/src/vocabulary.ts`) ranks a URL from its
path segments, using a multilingual pattern list: `career`, `careers`,
`karriere`, `jobs`, `stellen`, `stellenangebote`, `arbeiten`, `vacatures`,
`offres-emploi`, `empleo`, `lavora-con-noi`, and so on.

A career-section URL that is deep or contains a long number is classified as an
individual posting (`job`) rather than an index (`career`), and job URLs are
fetched first.

## Extraction

Two paths, in order of trust:

1. **schema.org JSON-LD** — parsed, validated with Zod, `@graph` traversed.
   Location, salary, employment type, dates and skills all map onto canonical
   values. Confidence 0.9.
2. **Heuristic HTML** — for the many sites publishing no structured data.
   Requires several independent signals ("Ihre Aufgaben", "Dein Profil",
   "Wir bieten", "Requirements", "Jetzt bewerben") before it will claim a page
   is a posting, so a careers *index* does not become a phantom vacancy.
   Confidence 0.35–0.75.

Before text extraction, block-level elements are padded with whitespace.
Cheerio's `.text()` concatenates without separators, so `<h2>Wir bieten</h2><p>Hybrid`
would otherwise read as `bietenHybrid` and defeat every keyword match downstream.

Nothing extracted is trusted as markup: descriptions are stored and rendered as
plain text, and every string passes through `sanitizeScrapedText`.

## XML safety

Sitemaps are parsed with `fast-xml-parser` configured with `processEntities:
false`, so entity-expansion attacks (billion laughs) and external entity
references are inert. Invalid XML is skipped, never fatal.

## Verification

`verifyJobUrl` re-checks a posting. The distinction that matters:

- **404 / 410, or a page that no longer contains a posting** → conclusive; the
  job is marked inactive (never deleted).
- **timeout, 429, 5xx, DNS failure** → inconclusive; the job is left untouched.

A flaky origin must not silently empty the index. Scheduling lives in the
`cleanup` queue: active jobs every `RECRAWL_JOB_HOURS` (24 h), companies every
`RECRAWL_COMPANY_DAYS` (14 d).
