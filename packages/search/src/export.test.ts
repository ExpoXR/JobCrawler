import type { SearchResultItem } from '@ejc/shared';
import { describe, expect, it } from 'vitest';

import { resultsToCsv, resultsToJson, toCsvValue } from './export';

const item: SearchResultItem = {
  id: 'result-1',
  kind: 'job',
  distanceKm: 14.2,
  match: {
    score: 92,
    rejected: false,
    rejectionReasons: [],
    components: [{ component: 'role', score: 1, weight: 2 }],
    evidence: [
      { kind: 'match', component: 'requiredSkills', label: 'react' },
      { kind: 'miss', component: 'preferredSkills', label: 'rust' },
    ],
  },
  job: {
    id: 'job-1',
    title: 'Frontend Developer',
    normalizedTitle: 'frontend developer',
    companyName: 'Beispiel GmbH',
    city: 'Kempten',
    workModel: 'hybrid',
    employmentType: 'full_time',
    seniority: 'mid',
    skills: ['react', 'next.js'],
    technologies: [],
    languages: [],
    applicationUrl: 'https://beispiel.de/karriere/frontend',
    sources: [{ url: 'https://beispiel.de/karriere/frontend', provider: 'career-page' }],
    isActive: true,
  },
};

describe('toCsvValue', () => {
  it('quotes values containing separators', () => {
    expect(toCsvValue('a,b')).toBe('"a,b"');
    expect(toCsvValue('line\nbreak')).toBe('"line\nbreak"');
    expect(toCsvValue('say "hi"')).toBe('"say ""hi"""');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A cell starting with = would otherwise execute on open.
    expect(toCsvValue('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(toCsvValue('+1234')).toBe("'+1234");
    expect(toCsvValue('-1234')).toBe("'-1234");
    expect(toCsvValue('@import')).toBe("'@import");
  });

  it('passes ordinary values through unchanged', () => {
    expect(toCsvValue('Frontend Developer')).toBe('Frontend Developer');
    expect(toCsvValue(92)).toBe('92');
    expect(toCsvValue(undefined)).toBe('');
  });
});

describe('resultsToCsv', () => {
  it('writes a header and one row per result', () => {
    const csv = resultsToCsv([item]);
    const lines = csv.trimEnd().split('\r\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('score');
    expect(lines[0]).toContain('source_urls');
    expect(lines[1]).toContain('92');
    expect(lines[1]).toContain('Frontend Developer');
  });

  it('includes source URLs so an export stays verifiable', () => {
    expect(resultsToCsv([item])).toContain('https://beispiel.de/karriere/frontend');
  });

  it('includes the match explanation', () => {
    const csv = resultsToCsv([item]);
    expect(csv).toContain('+ react');
    expect(csv).toContain('- rust');
  });

  it('starts with a UTF-8 BOM so European characters survive Excel', () => {
    expect(resultsToCsv([item]).charCodeAt(0)).toBe(0xfeff);
  });

  it('produces a header-only file for no results', () => {
    expect(resultsToCsv([]).trimEnd().split('\r\n')).toHaveLength(1);
  });
});

describe('resultsToJson', () => {
  it('emits valid JSON carrying evidence and sources', () => {
    const parsed = JSON.parse(resultsToJson([item], 'search-1')) as {
      searchId: string;
      resultCount: number;
      results: Array<{ score: number; evidence: unknown[] }>;
    };

    expect(parsed.searchId).toBe('search-1');
    expect(parsed.resultCount).toBe(1);
    expect(parsed.results[0]?.score).toBe(92);
    expect(parsed.results[0]?.evidence).toHaveLength(2);
  });
});
