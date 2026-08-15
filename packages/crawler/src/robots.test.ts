import { describe, expect, it } from 'vitest';

import { isPathAllowed, parseRobotsTxt, selectGroup } from './robots';

const UA = 'ExpoJobCrawler/0.1';

describe('parseRobotsTxt', () => {
  it('parses groups, rules, crawl-delay and sitemaps', () => {
    const robots = parseRobotsTxt(`
      # comment
      User-agent: *
      Disallow: /admin
      Allow: /admin/public
      Crawl-delay: 2

      User-agent: BadBot
      Disallow: /

      Sitemap: https://example.com/sitemap.xml
    `);

    expect(robots.groups).toHaveLength(2);
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(robots.groups[0]?.crawlDelaySeconds).toBe(2);
  });

  it('groups consecutive user-agent lines together', () => {
    const robots = parseRobotsTxt(`
      User-agent: alpha
      User-agent: beta
      Disallow: /private
    `);
    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.userAgents).toEqual(['alpha', 'beta']);
  });

  it('ignores malformed lines instead of throwing', () => {
    expect(() => parseRobotsTxt('this is not robots syntax\n\n\n')).not.toThrow();
  });
});

describe('selectGroup', () => {
  it('prefers the most specific matching user-agent over the wildcard', () => {
    const robots = parseRobotsTxt(`
      User-agent: *
      Disallow: /

      User-agent: expojobcrawler
      Disallow: /private
    `);
    const group = selectGroup(robots, UA);
    expect(group?.userAgents).toContain('expojobcrawler');
  });

  it('falls back to the wildcard group', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /nope');
    expect(selectGroup(robots, UA)?.userAgents).toEqual(['*']);
  });
});

describe('isPathAllowed', () => {
  it('allows everything when there are no rules', () => {
    expect(isPathAllowed(parseRobotsTxt(''), UA, '/careers').allowed).toBe(true);
  });

  it('treats an empty Disallow as allow-all', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow:');
    expect(isPathAllowed(robots, UA, '/anything').allowed).toBe(true);
  });

  it('blocks a disallowed prefix', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /admin');
    expect(isPathAllowed(robots, UA, '/admin/users').allowed).toBe(false);
    expect(isPathAllowed(robots, UA, '/careers').allowed).toBe(true);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /jobs\nAllow: /jobs/public');
    expect(isPathAllowed(robots, UA, '/jobs/private').allowed).toBe(false);
    expect(isPathAllowed(robots, UA, '/jobs/public/1').allowed).toBe(true);
  });

  it('supports * and $ wildcards', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /*.pdf$');
    expect(isPathAllowed(robots, UA, '/files/report.pdf').allowed).toBe(false);
    expect(isPathAllowed(robots, UA, '/files/report.pdf.html').allowed).toBe(true);
  });

  it('blocks the whole site on "Disallow: /"', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /');
    expect(isPathAllowed(robots, UA, '/').allowed).toBe(false);
    expect(isPathAllowed(robots, UA, '/careers').allowed).toBe(false);
  });

  it('reports the crawl delay, falling back to the supplied default', () => {
    const withDelay = parseRobotsTxt('User-agent: *\nCrawl-delay: 3\nDisallow: /x');
    expect(isPathAllowed(withDelay, UA, '/', 1000).crawlDelayMs).toBe(3000);

    const withoutDelay = parseRobotsTxt('User-agent: *\nDisallow: /x');
    expect(isPathAllowed(withoutDelay, UA, '/', 1500).crawlDelayMs).toBe(1500);
  });
});
