import { describe, expect, it } from 'vitest';

import { extractCompanyName, extractPage, selectRelevantLinks } from './extract';
import { extractJobFromHtml, extractJobsFromJsonLd } from './jobPosting';
import { parseSitemapXml, parseTextSitemap } from './sitemap';

const BASE = 'https://example.com/';

describe('extractPage', () => {
  it('extracts metadata, links and contact details', () => {
    const page = extractPage(
      `<!doctype html><html lang="de"><head>
        <title>Beispiel GmbH — Softwareentwicklung</title>
        <meta name="description" content="Wir entwickeln React-Anwendungen." />
        <link rel="canonical" href="https://example.com/home" />
      </head><body>
        <h1>Willkommen</h1>
        <a href="/karriere">Karriere</a>
        <a href="/kontakt">Kontakt</a>
        <a href="https://www.linkedin.com/company/beispiel">LinkedIn</a>
        <p>Kontakt: info@example.com oder +49 831 123456</p>
        <script>var tracking = 1;</script>
      </body></html>`,
      BASE,
    );

    expect(page.title).toBe('Beispiel GmbH — Softwareentwicklung');
    expect(page.description).toContain('React');
    expect(page.canonicalUrl).toBe('https://example.com/home');
    expect(page.language).toBe('de');
    expect(page.emails).toContain('info@example.com');
    expect(page.phones.length).toBeGreaterThan(0);
    expect(page.socialLinks['linkedin']).toContain('linkedin.com');
    // Script contents must not leak into the extracted text.
    expect(page.text).not.toContain('var tracking');
  });

  it('classifies career and contact links', () => {
    const page = extractPage(
      `<html><body>
        <a href="/karriere">Karriere</a>
        <a href="/kontakt">Kontakt</a>
        <a href="/blog/post-1">Blog</a>
      </body></html>`,
      BASE,
    );

    const career = page.links.find((link) => link.url.endsWith('/karriere'));
    const contact = page.links.find((link) => link.url.endsWith('/kontakt'));
    expect(career?.category).toBe('career');
    expect(contact?.category).toBe('contact');
  });

  it('survives malformed HTML', () => {
    expect(() => extractPage('<html><body><div><p>unclosed', BASE)).not.toThrow();
  });
});

describe('selectRelevantLinks', () => {
  it('keeps only same-origin career links', () => {
    const page = extractPage(
      `<html><body>
        <a href="/jobs">Jobs</a>
        <a href="https://other.example.org/careers">External careers</a>
        <a href="/impressum">Impressum</a>
      </body></html>`,
      BASE,
    );

    const links = selectRelevantLinks(page, BASE, 10);
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe('https://example.com/jobs');
  });
});

describe('extractJobsFromJsonLd', () => {
  it('reads a schema.org JobPosting', () => {
    const page = extractPage(
      `<html><body><script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Frontend Developer (m/w/d)",
        "description": "<p>Du arbeitest mit React und TypeScript.</p>",
        "datePosted": "2026-01-15",
        "validThrough": "2026-06-30",
        "employmentType": "FULL_TIME",
        "hiringOrganization": { "@type": "Organization", "name": "Beispiel GmbH" },
        "jobLocation": {
          "@type": "Place",
          "address": {
            "@type": "PostalAddress",
            "streetAddress": "Hauptstr. 1",
            "addressLocality": "Kempten",
            "addressCountry": "DE"
          },
          "geo": { "@type": "GeoCoordinates", "latitude": 47.7267, "longitude": 10.3168 }
        },
        "baseSalary": {
          "@type": "MonetaryAmount",
          "currency": "EUR",
          "value": { "@type": "QuantitativeValue", "minValue": 55000, "maxValue": 70000, "unitText": "YEAR" }
        }
      }
      </script></body></html>`,
      BASE,
    );

    const jobs = extractJobsFromJsonLd(page);
    expect(jobs).toHaveLength(1);

    const job = jobs[0];
    expect(job?.title).toBe('Frontend Developer (m/w/d)');
    expect(job?.companyName).toBe('Beispiel GmbH');
    expect(job?.city).toBe('Kempten');
    expect(job?.countryCode).toBe('DE');
    expect(job?.coordinates).toEqual({ lat: 47.7267, lon: 10.3168 });
    expect(job?.employmentType).toBe('full_time');
    expect(job?.salaryMin).toBe(55000);
    expect(job?.salaryMax).toBe(70000);
    expect(job?.salaryCurrency).toBe('EUR');
    expect(job?.salaryPeriod).toBe('year');
    expect(job?.skills).toContain('react');
    expect(job?.skills).toContain('typescript');
    // HTML inside the description must be stripped, never stored as markup.
    expect(job?.description).not.toContain('<p>');
  });

  it('finds postings nested in an @graph', () => {
    const page = extractPage(
      `<html><body><script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":"JobPosting","title":"Backend Engineer"}]}
      </script></body></html>`,
      BASE,
    );
    expect(extractJobsFromJsonLd(page)).toHaveLength(1);
  });

  it('ignores invalid JSON-LD without throwing', () => {
    const page = extractPage(
      `<html><body><script type="application/ld+json">{ not json }</script></body></html>`,
      BASE,
    );
    expect(extractJobsFromJsonLd(page)).toEqual([]);
  });
});

describe('extractJobFromHtml', () => {
  it('recognises a posting page by its section headings', () => {
    const page = extractPage(
      `<html><body>
        <h1>Frontend Entwickler</h1>
        <h2>Deine Aufgaben</h2><p>React-Anwendungen bauen.</p>
        <h2>Dein Profil</h2><p>Mindestens 3 Jahre Erfahrung mit TypeScript.</p>
        <h2>Wir bieten</h2><p>Hybrid arbeiten.</p>
      </body></html>`,
      'https://example.com/karriere/frontend-entwickler',
    );

    const job = extractJobFromHtml(page, 'https://example.com/karriere/frontend-entwickler');
    expect(job).toBeDefined();
    expect(job?.title).toBe('Frontend Entwickler');
    expect(job?.extraction).toBe('heuristic');
    expect(job?.requiredExperienceYears).toBe(3);
    expect(job?.workModel).toBe('hybrid');
  });

  it('does not invent a vacancy from a careers index page', () => {
    const page = extractPage(
      `<html><body><h1>Karriere</h1><p>Aktuell keine offenen Stellen.</p></body></html>`,
      'https://example.com/karriere',
    );
    expect(extractJobFromHtml(page, 'https://example.com/karriere')).toBeUndefined();
  });
});

describe('sitemap parsing', () => {
  it('parses a urlset', () => {
    const parsed = parseSitemapXml(`<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url>
        <url><loc>https://example.com/karriere</loc></url>
      </urlset>`);

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.lastModified).toBe('2026-01-01');
  });

  it('parses a sitemap index', () => {
    const parsed = parseSitemapXml(`<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
      </sitemapindex>`);

    expect(parsed.indexUrls).toEqual(['https://example.com/sitemap-1.xml']);
  });

  it('respects the entry limit', () => {
    const urls = Array.from(
      { length: 50 },
      (_value, index) => `<url><loc>https://example.com/${index}</loc></url>`,
    ).join('');
    const parsed = parseSitemapXml(`<urlset>${urls}</urlset>`, 10);
    expect(parsed.entries).toHaveLength(10);
  });

  it('rejects documents that are neither urlset nor sitemapindex', () => {
    expect(() => parseSitemapXml('<html><body>nope</body></html>')).toThrow();
  });

  it('parses plain-text sitemaps', () => {
    const entries = parseTextSitemap('https://example.com/a\nnot-a-url\nhttps://example.com/b');
    expect(entries.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });
});

describe('extractCompanyName', () => {
  it('prefers the leading part of the page title', () => {
    const page = extractPage('<html><head><title>Beispiel GmbH | Home</title></head></html>', BASE);
    expect(extractCompanyName(page, 'example.com')).toBe('Beispiel GmbH');
  });

  it('falls back to the hostname', () => {
    const page = extractPage('<html><head></head><body></body></html>', BASE);
    expect(extractCompanyName(page, 'www.beispiel.de')).toBe('Beispiel');
  });
});
