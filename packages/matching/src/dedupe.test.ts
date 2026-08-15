import type { Job } from '@ejc/shared';
import { describe, expect, it } from 'vitest';

import { compareJobs, dedupeJobs, isAggregatorUrl, preferredApplicationUrl } from './dedupe';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job',
    title: 'Frontend Developer',
    normalizedTitle: 'frontend developer',
    companyName: 'Beispiel GmbH',
    city: 'Kempten',
    workModel: 'hybrid',
    employmentType: 'full_time',
    seniority: 'mid',
    skills: ['react'],
    technologies: [],
    languages: [],
    sources: [],
    isActive: true,
    ...overrides,
  };
}

describe('compareJobs', () => {
  it('treats an identical canonical URL as conclusive', () => {
    const a = makeJob({
      applicationUrl: 'https://example.com/jobs/1?utm_source=linkedin',
      companyName: 'A',
    });
    const b = makeJob({ applicationUrl: 'https://example.com/jobs/1', companyName: 'B' });

    const verdict = compareJobs(a, b);
    expect(verdict.isDuplicate).toBe(true);
    expect(verdict.confidence).toBe(1);
  });

  it('merges the same posting seen on two providers', () => {
    const employer = makeJob({
      id: '1',
      sources: [{ url: 'https://beispiel.de/karriere/frontend', provider: 'career-page' }],
    });
    const aggregator = makeJob({
      id: '2',
      title: 'Frontend Developer (m/w/d)',
      sources: [{ url: 'https://www.linkedin.com/jobs/view/123', provider: 'linkedin' }],
    });

    expect(compareJobs(employer, aggregator).isDuplicate).toBe(true);
  });

  it('keeps different employers apart even with the same title', () => {
    const a = makeJob({ companyName: 'Alpha GmbH' });
    const b = makeJob({ companyName: 'Beta AG' });
    expect(compareJobs(a, b).isDuplicate).toBe(false);
  });

  it('keeps different roles at the same employer apart', () => {
    const a = makeJob({ title: 'Frontend Developer' });
    const b = makeJob({ title: 'Head of Finance' });
    expect(compareJobs(a, b).isDuplicate).toBe(false);
  });

  it('keeps the same role in different cities apart', () => {
    const a = makeJob({ city: 'Kempten' });
    const b = makeJob({ city: 'Hamburg' });
    expect(compareJobs(a, b).isDuplicate).toBe(false);
  });

  it('ignores legal-form differences in the employer name', () => {
    const a = makeJob({ companyName: 'Beispiel GmbH' });
    const b = makeJob({ companyName: 'Beispiel' });
    expect(compareJobs(a, b).isDuplicate).toBe(true);
  });
});

describe('isAggregatorUrl', () => {
  it('recognises job boards and ATS hosts', () => {
    expect(isAggregatorUrl('https://www.linkedin.com/jobs/view/1')).toBe(true);
    expect(isAggregatorUrl('https://beispiel.jobs.personio.de/job/1')).toBe(true);
    expect(isAggregatorUrl('https://beispiel.de/karriere/frontend')).toBe(false);
  });
});

describe('preferredApplicationUrl', () => {
  it("prefers the employer's own domain", () => {
    const url = preferredApplicationUrl(
      [
        { url: 'https://www.linkedin.com/jobs/view/1' },
        { url: 'https://beispiel.de/karriere/frontend' },
      ],
      'beispiel.de',
    );
    expect(url).toBe('https://beispiel.de/karriere/frontend');
  });

  it('falls back to any non-aggregator source', () => {
    const url = preferredApplicationUrl([
      { url: 'https://www.indeed.com/viewjob?jk=1' },
      { url: 'https://kleinefirma.de/jobs/1' },
    ]);
    expect(url).toBe('https://kleinefirma.de/jobs/1');
  });

  it('falls back to the first source when everything is an aggregator', () => {
    const url = preferredApplicationUrl([
      { url: 'https://www.indeed.com/viewjob?jk=1' },
      { url: 'https://www.linkedin.com/jobs/view/2' },
    ]);
    expect(url).toBe('https://www.indeed.com/viewjob?jk=1');
  });

  it('returns undefined with no sources', () => {
    expect(preferredApplicationUrl([])).toBeUndefined();
  });
});

describe('dedupeJobs', () => {
  it('collapses duplicates while keeping every source URL', () => {
    const jobs = [
      makeJob({
        id: '1',
        description: 'Short description.',
        sources: [{ url: 'https://beispiel.de/karriere/frontend', provider: 'career-page' }],
      }),
      makeJob({
        id: '2',
        title: 'Frontend Developer (m/w/d)',
        description: 'A considerably longer and more detailed description of the same role.',
        publishedAt: '2026-01-01T00:00:00Z',
        skills: ['react', 'typescript'],
        sources: [{ url: 'https://www.linkedin.com/jobs/view/123', provider: 'linkedin' }],
      }),
      makeJob({ id: '3', companyName: 'Anderes Unternehmen', title: 'Backend Developer' }),
    ];

    const groups = dedupeJobs(jobs);
    expect(groups).toHaveLength(2);

    const merged = groups[0];
    expect(merged?.merged).toHaveLength(1);
    expect(merged?.job.sources.map((source) => source.url)).toEqual([
      'https://beispiel.de/karriere/frontend',
      'https://www.linkedin.com/jobs/view/123',
    ]);
    // The richer description and the union of skills survive the merge.
    expect(merged?.job.description).toContain('considerably longer');
    expect(merged?.job.skills).toContain('typescript');
    // The employer's page wins the application link over the aggregator.
    expect(merged?.job.applicationUrl).toBe('https://beispiel.de/karriere/frontend');
  });

  it('is a no-op for a list with no duplicates', () => {
    const jobs = [
      makeJob({ id: '1', companyName: 'Alpha' }),
      makeJob({ id: '2', companyName: 'Beta' }),
    ];
    expect(dedupeJobs(jobs)).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(dedupeJobs([])).toEqual([]);
  });
});
