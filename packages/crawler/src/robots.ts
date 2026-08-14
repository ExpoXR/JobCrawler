/**
 * robots.txt parsing (plan section 10).
 *
 * Implements the parts of RFC 9309 that matter for a polite crawler: group
 * selection by user-agent, longest-match Allow/Disallow with `*` and `$`
 * wildcards, Crawl-delay, and Sitemap discovery.
 *
 * A missing or unreadable robots.txt means "allowed" (per the RFC); a 5xx means
 * "disallowed" so that a broken origin is not hammered.
 */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobotsTxt(body: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let current: RobotsGroup | undefined;
  // Consecutive User-agent lines share one group of rules.
  let acceptingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!current || !acceptingAgents) {
          current = { userAgents: [], rules: [] };
          groups.push(current);
          acceptingAgents = true;
        }
        current.userAgents.push(value.toLowerCase());
        break;
      }
      case 'allow':
      case 'disallow': {
        if (!current) {
          current = { userAgents: ['*'], rules: [] };
          groups.push(current);
        }
        acceptingAgents = false;
        current.rules.push({ type: field, path: value });
        break;
      }
      case 'crawl-delay': {
        if (current) {
          const seconds = Number.parseFloat(value);
          if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
        }
        acceptingAgents = false;
        break;
      }
      case 'sitemap': {
        if (value) sitemaps.push(value);
        break;
      }
      default:
        break;
    }
  }

  return { groups, sitemaps };
}

/** Picks the most specific matching group, falling back to `*`. */
export function selectGroup(robots: RobotsTxt, userAgent: string): RobotsGroup | undefined {
  const agent = userAgent.toLowerCase();
  let best: { group: RobotsGroup; length: number } | undefined;
  let wildcard: RobotsGroup | undefined;

  for (const group of robots.groups) {
    for (const candidate of group.userAgents) {
      if (candidate === '*') {
        wildcard ??= group;
        continue;
      }
      if (agent.includes(candidate) && (!best || candidate.length > best.length)) {
        best = { group, length: candidate.length };
      }
    }
  }

  return best?.group ?? wildcard;
}

/** Converts a robots path pattern into an anchored regular expression. */
function patternToRegExp(pattern: string): RegExp {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') {
      source += '.*';
    } else if (char === '$') {
      source += '$';
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(source);
}

function matchLength(rule: RobotsRule, path: string): number {
  // An empty value ("Disallow:") is equivalent to having no rule at all.
  if (rule.path === '') return -1;
  try {
    return patternToRegExp(rule.path).test(path) ? rule.path.replace(/\*/g, '').length : -1;
  } catch {
    return -1;
  }
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
  matchedRule?: string;
}

/**
 * Decides whether `pathname` may be fetched.
 *
 * An empty Disallow value means "allow everything"; the longest matching rule
 * wins, and Allow beats Disallow on an equal-length tie.
 */
export function isPathAllowed(
  robots: RobotsTxt,
  userAgent: string,
  pathname: string,
  defaultDelayMs = 0,
): RobotsDecision {
  const group = selectGroup(robots, userAgent);
  const crawlDelayMs =
    group?.crawlDelaySeconds !== undefined
      ? Math.round(group.crawlDelaySeconds * 1000)
      : defaultDelayMs;

  if (!group || group.rules.length === 0) return { allowed: true, crawlDelayMs };

  let bestAllow = -1;
  let bestDisallow = -1;
  let matchedRule: string | undefined;

  for (const rule of group.rules) {
    const length = matchLength(rule, pathname);
    if (length < 0) continue;
    if (rule.type === 'allow' && length > bestAllow) {
      bestAllow = length;
      if (length >= bestDisallow) matchedRule = `Allow: ${rule.path}`;
    } else if (rule.type === 'disallow' && length > bestDisallow) {
      bestDisallow = length;
      if (length > bestAllow) matchedRule = `Disallow: ${rule.path}`;
    }
  }

  const allowed = bestDisallow < 0 || bestAllow >= bestDisallow;
  const decision: RobotsDecision = { allowed, crawlDelayMs };
  if (matchedRule) decision.matchedRule = matchedRule;
  return decision;
}
