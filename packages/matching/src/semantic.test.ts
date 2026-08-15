import type { Company, Job, SearchQuery } from '@ejc/shared';
import { describe, expect, it } from 'vitest';

import { scoreJob, scorePotentialEmployer } from './score';

/**
 * Regression tests for the semantic component.
 *
 * The first implementation computed a query embedding and then passed
 * `semanticSimilarity: undefined`, so the component silently never applied.
 * These assert that a supplied similarity actually moves the score.
 */

function makeQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    mode: 'jobs',
    locationText: 'Kempten',
    location: { lat: 47.7267, lon: 10.3168, label: 'Kempten' },
    radiusKm: 50,
    role: 'React Developer',
    requiredSkills: [],
    preferredSkills: [],
    technologies: [],
    employmentTypes: [],
    workModels: [],
    industries: [],
    languages: [],
    companySizes: [],
    keywords: [],
    exclusions: [],
    includePotentialEmployers: true,
    minMatchScore: 0,
    ...overrides,
  };
}

const job: Job = {
  id: 'job-1',
  title: 'Frontend Engineer',
  normalizedTitle: 'frontend engineer',
  workModel: 'hybrid',
  employmentType: 'full_time',
  seniority: 'mid',
  skills: ['react'],
  technologies: [],
  languages: [],
  sources: [],
  isActive: true,
};

const company: Company = {
  id: 'company-1',
  name: 'Beispiel GmbH',
  normalizedName: 'beispiel',
  technologies: ['react'],
  services: [],
  socialLinks: {},
  sitemapUrls: [],
  activeJobCount: 0,
  sources: [],
};

const NOW = new Date('2026-02-01T00:00:00Z');

describe('semantic component on jobs', () => {
  it('raises the score when semantic similarity is high', () => {
    const high = scoreJob(makeQuery(), job, undefined, {
      distanceKm: 10,
      semanticSimilarity: 0.95,
      now: NOW,
    });
    const low = scoreJob(makeQuery(), job, undefined, {
      distanceKm: 10,
      semanticSimilarity: 0.1,
      now: NOW,
    });

    expect(high.score).toBeGreaterThan(low.score);
  });

  it('records a semantic component only when a similarity is supplied', () => {
    const withSemantic = scoreJob(makeQuery(), job, undefined, {
      distanceKm: 10,
      semanticSimilarity: 0.8,
      now: NOW,
    });
    const without = scoreJob(makeQuery(), job, undefined, { distanceKm: 10, now: NOW });

    expect(withSemantic.components.some((entry) => entry.component === 'semantic')).toBe(true);
    expect(without.components.some((entry) => entry.component === 'semantic')).toBe(false);
  });

  it('treats an explicit zero as a real signal, not as absent', () => {
    const zero = scoreJob(makeQuery(), job, undefined, {
      distanceKm: 10,
      semanticSimilarity: 0,
      now: NOW,
    });
    const absent = scoreJob(makeQuery(), job, undefined, { distanceKm: 10, now: NOW });

    expect(zero.components.some((entry) => entry.component === 'semantic')).toBe(true);
    expect(zero.score).toBeLessThan(absent.score);
  });
});

describe('semantic component on potential employers', () => {
  it('applies to companies too', () => {
    const high = scorePotentialEmployer(makeQuery(), company, {
      distanceKm: 10,
      semanticSimilarity: 0.9,
    });
    const low = scorePotentialEmployer(makeQuery(), company, {
      distanceKm: 10,
      semanticSimilarity: 0.1,
    });

    expect(high.score).toBeGreaterThan(low.score);
  });
});
