import { AppError, canonicalizeSkills, getConfig, getLogger, truncate } from '@ejc/shared';

import type {
  CandidateProvider,
  CandidateSearchQuery,
  DiscoveredCandidate,
  ProviderContext,
  ProviderInfo,
} from '../types';

/**
 * Candidate discovery via the public GitHub Search API (plan section 12).
 *
 * Scope, deliberately narrow (plan section 40):
 *   - only fields GitHub itself publishes on a public profile
 *   - no email harvesting, no contribution mining, no private data
 *   - the stored record is a pointer back to the profile, not a copy of it
 *
 * Works unauthenticated at a low rate limit; set `GITHUB_TOKEN` to raise it.
 */

interface GitHubUserSearchResponse {
  items?: Array<{ login?: string; html_url?: string; type?: string }>;
}

interface GitHubUser {
  login?: string;
  name?: string | null;
  bio?: string | null;
  location?: string | null;
  blog?: string | null;
  html_url?: string;
  hireable?: boolean | null;
  type?: string;
}

const API_BASE = 'https://api.github.com';

export class GitHubCandidateProvider implements CandidateProvider {
  readonly info: ProviderInfo = {
    key: 'github',
    name: 'GitHub public profiles',
    homepage: 'https://docs.github.com/en/rest/search',
    capabilities: ['api-search', 'profile-discovery', 'external-link-only'],
    rateLimitPerMinute: 10,
  };

  isAvailable(): boolean {
    return true;
  }

  private headers(): Record<string, string> {
    const config = getConfig();
    const token = process.env['GITHUB_TOKEN'] ?? '';
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': config.crawler.userAgent,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /** Builds a GitHub user-search query from the structured search. */
  buildSearchQuery(query: CandidateSearchQuery): string {
    const parts: string[] = ['type:user'];

    const location = query.query.location?.city ?? query.query.locationText;
    if (location) parts.push(`location:"${location.replace(/"/g, '')}"`);

    // GitHub indexes one primary language per repo; use the first known one.
    const languageSkill = [...query.query.requiredSkills, ...query.query.technologies].find(
      (skill) =>
        ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'php', 'ruby', 'c#'].includes(
          skill.toLowerCase(),
        ),
    );
    if (languageSkill) parts.push(`language:${languageSkill.replace('#', 'sharp')}`);

    const keywords = [query.query.role, ...query.query.keywords]
      .filter((entry) => entry && entry.trim().length > 1)
      .slice(0, 2);
    parts.unshift(...keywords.map((keyword) => `${keyword}`));

    return parts.join(' ');
  }

  async searchCandidates(
    query: CandidateSearchQuery,
    context: ProviderContext = {},
  ): Promise<DiscoveredCandidate[]> {
    const limit = Math.min(query.limit ?? 20, 50);
    const searchQuery = this.buildSearchQuery(query);

    let logins: string[];
    try {
      const url = new URL('/search/users', API_BASE);
      url.searchParams.set('q', searchQuery);
      url.searchParams.set('per_page', String(limit));

      const payload = await this.request<GitHubUserSearchResponse>(url, context);
      logins = (payload.items ?? [])
        .filter((item) => item.type !== 'Organization' && item.login)
        .map((item) => item.login as string)
        .slice(0, limit);
    } catch (error) {
      getLogger('providers').warn('GitHub candidate search failed', {
        provider: this.info.key,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const candidates: DiscoveredCandidate[] = [];
    const wantedSkills = canonicalizeSkills([
      ...query.query.requiredSkills,
      ...query.query.preferredSkills,
      ...query.query.technologies,
    ]);

    // Profiles are fetched one at a time on purpose: the unauthenticated rate
    // limit is small and a burst would get the deployment throttled.
    for (const login of logins) {
      if (context.signal?.aborted) break;
      try {
        const user = await this.request<GitHubUser>(
          new URL(`/users/${encodeURIComponent(login)}`, API_BASE),
          context,
        );
        const candidate = this.toCandidate(user, wantedSkills);
        if (candidate) candidates.push(candidate);
      } catch {
        // One unreachable profile must not end the search.
      }
    }

    return candidates;
  }

  private toCandidate(
    user: GitHubUser,
    wantedSkills: readonly string[],
  ): DiscoveredCandidate | undefined {
    if (!user.login || !user.html_url || user.type === 'Organization') return undefined;

    const bio = user.bio ?? '';
    // Skills are only claimed when the profile itself mentions them.
    const skills = canonicalizeSkills(
      wantedSkills.filter((skill) => bio.toLowerCase().includes(skill.toLowerCase())),
    );

    const candidate: DiscoveredCandidate = {
      profileUrl: user.html_url,
      githubUrl: user.html_url,
      provider: this.info.key,
    };

    if (user.name) candidate.publicName = truncate(user.name, 120);
    if (bio) candidate.publicTitle = truncate(bio, 200);
    if (user.location) candidate.approximateLocation = truncate(user.location, 120);
    if (skills.length > 0) {
      candidate.skills = skills;
      candidate.technologies = skills;
    }

    const blog = user.blog?.trim();
    if (blog) {
      const url = blog.startsWith('http') ? blog : `https://${blog}`;
      try {
        candidate.portfolioUrl = new URL(url).toString();
      } catch {
        // Ignore malformed profile URLs.
      }
    }

    return candidate;
  }

  private async request<T>(url: URL, context: ProviderContext): Promise<T> {
    const config = getConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.crawler.timeoutMs);
    const onAbort = () => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, { signal: controller.signal, headers: this.headers() });
      if (!response.ok) {
        throw new AppError(
          response.status === 403 || response.status === 429 ? 'rate_limited' : 'provider_unavailable',
          `GitHub returned ${response.status}`,
          { context: { provider: this.info.key, status: response.status } },
        );
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export const githubCandidateProvider = new GitHubCandidateProvider();
