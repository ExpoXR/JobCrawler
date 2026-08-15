import type { Candidate, Company, Job, SearchQuery } from '@ejc/shared';
import { describe, expect, it } from 'vitest';

import { distanceScore, roleSimilarity, scoreCandidate, scoreJob, scorePotentialEmployer } from './score';

function makeQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    mode: 'jobs',
    locationText: 'Kempten',
    location: { lat: 47.7267, lon: 10.3168, label: 'Kempten' },
    radiusKm: 50,
    role: 'React Developer',
    requiredSkills: ['react'],
    preferredSkills: ['next.js'],
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

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'React Developer',
    normalizedTitle: 'react developer',
    workModel: 'hybrid',
    employmentType: 'full_time',
    seniority: 'mid',
    skills: ['react', 'next.js', 'typescript'],
    technologies: [],
    languages: [],
    sources: [{ url: 'https://example.com/jobs/1', provider: 'career-page' }],
    isActive: true,
    ...overrides,
  };
}

const NOW = new Date('2026-02-01T00:00:00Z');

describe('scoreJob', () => {
  it('scores a strong match highly', () => {
    const result = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm: 5, now: NOW });
    expect(result.rejected).toBe(false);
    expect(result.score).toBeGreaterThan(75);
  });

  it('rejects a job missing a hard-required skill', () => {
    const result = scoreJob(
      makeQuery({ requiredSkills: ['rust'] }),
      makeJob(),
      undefined,
      { distanceKm: 5, now: NOW },
    );
    expect(result.rejected).toBe(true);
    expect(result.score).toBe(0);
    expect(result.rejectionReasons[0]).toContain('rust');
  });

  it('rejects a job outside the radius', () => {
    const result = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm: 120, now: NOW });
    expect(result.rejected).toBe(true);
    expect(result.rejectionReasons[0]).toContain('radius');
  });

  it('rejects a result matching an exclusion term', () => {
    const result = scoreJob(
      makeQuery({ exclusions: ['recruiting agency'] }),
      makeJob({ description: 'We are a recruiting agency placing developers.' }),
      undefined,
      { distanceKm: 5, now: NOW },
    );
    expect(result.rejected).toBe(true);
  });

  it('prefers the nearer of two otherwise identical jobs', () => {
    const near = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm: 5, now: NOW });
    const far = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm: 45, now: NOW });
    expect(near.score).toBeGreaterThan(far.score);
  });

  it('produces evidence for both matched and missing skills', () => {
    const result = scoreJob(
      makeQuery({ preferredSkills: ['next.js', 'rust'] }),
      makeJob(),
      undefined,
      { distanceKm: 5, now: NOW },
    );

    const labels = result.evidence.map((entry) => entry.label);
    expect(labels).toContain('next.js');
    expect(labels).toContain('rust');
    expect(result.evidence.some((entry) => entry.kind === 'match')).toBe(true);
  });

  it('does not penalise a job for missing salary data', () => {
    const withoutSalary = scoreJob(
      makeQuery({ salaryMin: 60_000 }),
      makeJob(),
      undefined,
      { distanceKm: 5, now: NOW },
    );
    const baseline = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm: 5, now: NOW });
    expect(withoutSalary.score).toBe(baseline.score);
  });

  it('rewards a salary that meets the requirement', () => {
    const meets = scoreJob(
      makeQuery({ salaryMin: 60_000 }),
      makeJob({ salaryMin: 65_000, salaryMax: 75_000, salaryCurrency: 'EUR' }),
      undefined,
      { distanceKm: 5, now: NOW },
    );
    const below = scoreJob(
      makeQuery({ salaryMin: 60_000 }),
      makeJob({ salaryMin: 30_000, salaryMax: 35_000, salaryCurrency: 'EUR' }),
      undefined,
      { distanceKm: 5, now: NOW },
    );
    expect(meets.score).toBeGreaterThan(below.score);
  });

  it('ranks a fresh posting above a stale one', () => {
    const fresh = scoreJob(
      makeQuery(),
      makeJob({ publishedAt: '2026-01-28T00:00:00Z' }),
      undefined,
      { distanceKm: 5, now: NOW },
    );
    const stale = scoreJob(
      makeQuery(),
      makeJob({ publishedAt: '2025-06-01T00:00:00Z' }),
      undefined,
      { distanceKm: 5, now: NOW },
    );
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it('always returns a score between 0 and 100', () => {
    for (const distanceKm of [0, 10, 49.9]) {
      const result = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm, now: NOW });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic', () => {
    const a = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm: 12, now: NOW });
    const b = scoreJob(makeQuery(), makeJob(), undefined, { distanceKm: 12, now: NOW });
    expect(a.score).toBe(b.score);
  });
});

describe('scorePotentialEmployer', () => {
  const company: Company = {
    id: 'company-1',
    name: 'Beispiel GmbH',
    normalizedName: 'beispiel',
    technologies: ['react', 'next.js'],
    services: ['web development'],
    socialLinks: {},
    sitemapUrls: [],
    activeJobCount: 0,
    sources: [],
    industry: 'Software',
  };

  it('scores a technology-matched company without requiring a vacancy', () => {
    const result = scorePotentialEmployer(makeQuery(), company, { distanceKm: 18 });
    expect(result.rejected).toBe(false);
    expect(result.score).toBeGreaterThan(50);
  });

  it('does not reject for a missing required skill', () => {
    // A website that never mentions Rust is not proof the company avoids it.
    const result = scorePotentialEmployer(
      makeQuery({ requiredSkills: ['rust'] }),
      company,
      { distanceKm: 10 },
    );
    expect(result.rejected).toBe(false);
  });

  it('still enforces the radius', () => {
    const result = scorePotentialEmployer(makeQuery(), company, { distanceKm: 200 });
    expect(result.rejected).toBe(true);
  });

  it('explains that there is no active vacancy', () => {
    const result = scorePotentialEmployer(makeQuery(), company, { distanceKm: 10 });
    expect(result.evidence.some((entry) => entry.label.includes('No active vacancy'))).toBe(true);
  });
});

describe('scoreCandidate', () => {
  const candidate: Candidate = {
    id: 'candidate-1',
    publicTitle: 'Frontend Developer',
    skills: ['react', 'typescript'],
    technologies: [],
    profileUrl: 'https://github.com/example',
    sources: [],
  };

  it('scores a matching profile and cites its source', () => {
    const result = scoreCandidate(makeQuery({ mode: 'candidates' }), candidate, {
      distanceKm: 8,
    });
    expect(result.rejected).toBe(false);
    expect(result.score).toBeGreaterThan(50);
    expect(result.evidence.some((entry) => entry.sourceUrl === candidate.profileUrl)).toBe(true);
  });

  it('rejects a profile without a required skill', () => {
    const result = scoreCandidate(
      makeQuery({ mode: 'candidates', requiredSkills: ['kubernetes'] }),
      candidate,
      { distanceKm: 8 },
    );
    expect(result.rejected).toBe(true);
  });
});

describe('distanceScore', () => {
  it('decays from 1 at the centre to 0 at the radius', () => {
    expect(distanceScore(0, 50)).toBe(1);
    expect(distanceScore(25, 50)).toBeCloseTo(0.5);
    expect(distanceScore(50, 50)).toBe(0);
    expect(distanceScore(80, 50)).toBe(0);
  });

  it('handles degenerate input', () => {
    expect(distanceScore(10, 0)).toBe(0);
    expect(distanceScore(Number.NaN, 50)).toBe(0);
  });
});

describe('roleSimilarity', () => {
  it('is 1 for the same role and high for a variant', () => {
    expect(roleSimilarity('React Developer', 'React Developer')).toBe(1);
    expect(roleSimilarity('React Developer', 'React Developer (m/w/d)')).toBe(1);
    expect(roleSimilarity('Frontend Developer', 'Frontend Engineer')).toBeGreaterThan(0.3);
  });

  it('is low for unrelated roles', () => {
    expect(roleSimilarity('React Developer', 'Truck Driver')).toBeLessThan(0.2);
  });

  it('handles empty input', () => {
    expect(roleSimilarity('', 'React Developer')).toBe(0);
  });
});
