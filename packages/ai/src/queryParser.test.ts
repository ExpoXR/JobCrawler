import type { SearchQuery } from '@ejc/shared';
import { describe, expect, it } from 'vitest';

import {
  applyParsedQuery,
  extractExclusions,
  extractJsonObject,
  extractLocationHint,
  extractRole,
  extractSalary,
  mergeParsedQueries,
  parseQueryHeuristically,
} from './queryParser';

/**
 * The heuristic parser is what runs when no AI provider is configured, so it
 * carries the MVP. These tests pin the behaviour the plan's own example
 * queries depend on.
 */

describe('extractLocationHint', () => {
  it('reads the plan\'s example query', () => {
    const hint = extractLocationHint('Find frontend developer jobs within 40 km of Kempten.');
    expect(hint?.radiusKm).toBe(40);
  });

  it('handles German phrasing', () => {
    const hint = extractLocationHint('Stellen im Umkreis von 30 km bei Memmingen');
    expect(hint?.radiusKm).toBe(30);
    expect(hint?.locationText).toBe('Memmingen');
  });

  it('finds a location without a radius', () => {
    expect(extractLocationHint('React jobs in Munich')?.locationText).toBe('Munich');
  });

  it('stops at a sentence boundary instead of absorbing the next sentence', () => {
    const hint = extractLocationHint(
      'Find jobs within 40 km of Kempten. I know React and TypeScript.',
    );
    expect(hint?.locationText).toBe('Kempten');
  });

  it('keeps a legitimate full stop inside a place name', () => {
    expect(extractLocationHint('Jobs in St. Gallen')?.locationText).toBe('St. Gallen');
  });

  it('returns undefined when there is nothing to find', () => {
    expect(extractLocationHint('just some words')).toBeUndefined();
  });
});

describe('extractRole', () => {
  it('extracts a role from an English request', () => {
    expect(extractRole('Find frontend developer jobs in Kempten')?.toLowerCase()).toContain(
      'frontend developer',
    );
  });

  it('extracts a role from a German request', () => {
    expect(extractRole('Ich suche einen React Entwickler in Kempten')?.toLowerCase()).toContain(
      'react entwickler',
    );
  });

  it('recognises a bare role phrase', () => {
    expect(extractRole('Senior Backend Engineer wanted')?.toLowerCase()).toContain(
      'backend engineer',
    );
  });
});

describe('extractSalary', () => {
  it('understands the k shorthand', () => {
    expect(extractSalary('at least 60k EUR')).toEqual({ salaryMin: 60_000, salaryCurrency: 'EUR' });
  });

  it('understands a full amount', () => {
    expect(extractSalary('mindestens 65.000 EUR')).toEqual({
      salaryMin: 65_000,
      salaryCurrency: 'EUR',
    });
  });

  it('returns nothing when no salary is mentioned', () => {
    expect(extractSalary('React developer in Kempten')).toEqual({});
  });
});

describe('extractExclusions', () => {
  it('picks up negated terms', () => {
    const exclusions = extractExclusions('React jobs but no recruiting agency, not remote only');
    expect(exclusions.some((entry) => entry.includes('recruiting agency'))).toBe(true);
  });
});

describe('parseQueryHeuristically', () => {
  it('parses the full example from the plan', () => {
    const parsed = parseQueryHeuristically(
      `Find frontend developer jobs within 40 km of Kempten.
       I know React, Next.js, TypeScript, WordPress and Node.js.
       I prefer smaller agencies and hybrid work.`,
    );

    expect(parsed.radiusKm).toBe(40);
    expect(parsed.locationText).toBe('Kempten');
    expect(parsed.role?.toLowerCase()).toContain('frontend developer');
    expect(parsed.preferredSkills).toEqual(
      expect.arrayContaining(['react', 'next.js', 'typescript', 'wordpress', 'node.js']),
    );
    expect(parsed.workModels).toEqual(['hybrid']);
    expect(parsed.companySizes).toContain('small');
  });

  it('parses a German query', () => {
    const parsed = parseQueryHeuristically(
      'Ich suche eine Teilzeitstelle als React Entwickler im Umkreis von 25 km bei Kempten, mindestens 3 Jahre Erfahrung.',
    );
    expect(parsed.radiusKm).toBe(25);
    expect(parsed.minExperienceYears).toBe(3);
    expect(parsed.preferredSkills).toContain('react');
  });

  it('returns an empty object for unusable input', () => {
    expect(parseQueryHeuristically('...')).toEqual({});
  });
});

describe('extractJsonObject', () => {
  it('reads a bare JSON object', () => {
    expect(extractJsonObject('{"role":"React Developer"}')).toEqual({ role: 'React Developer' });
  });

  it('reads JSON inside a fenced block', () => {
    expect(extractJsonObject('Here you go:\n```json\n{"radiusKm": 40}\n```')).toEqual({
      radiusKm: 40,
    });
  });

  it('returns undefined for non-JSON output', () => {
    expect(extractJsonObject('I could not determine any filters.')).toBeUndefined();
  });
});

describe('mergeParsedQueries', () => {
  it('unions arrays and lets the overlay fill gaps', () => {
    const merged = mergeParsedQueries(
      { role: 'React Developer', preferredSkills: ['react'] },
      { preferredSkills: ['next.js'], seniority: 'senior' },
    );
    expect(merged.role).toBe('React Developer');
    expect(merged.preferredSkills).toEqual(['react', 'next.js']);
    expect(merged.seniority).toBe('senior');
  });

  it('never lets an empty overlay value erase a parsed one', () => {
    const merged = mergeParsedQueries({ locationText: 'Kempten' }, { locationText: '   ' });
    expect(merged.locationText).toBe('Kempten');
  });
});

describe('applyParsedQuery', () => {
  const base: SearchQuery = {
    mode: 'jobs',
    locationText: '',
    radiusKm: 50,
    role: '',
    requiredSkills: ['react'],
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
    crawlWebsitesInRadius: false,
    minMatchScore: 0,
  };

  it('fills empty fields and unions lists', () => {
    const result = applyParsedQuery(base, {
      locationText: 'Kempten',
      radiusKm: 40,
      role: 'Frontend Developer',
      preferredSkills: ['next.js'],
      requiredSkills: ['typescript'],
    });

    expect(result.locationText).toBe('Kempten');
    expect(result.radiusKm).toBe(40);
    expect(result.role).toBe('Frontend Developer');
    expect(result.requiredSkills).toEqual(['react', 'typescript']);
    expect(result.preferredSkills).toEqual(['next.js']);
  });

  it('does not overwrite what the user typed explicitly', () => {
    const explicit = { ...base, locationText: 'Munich', role: 'Backend Developer' };
    const result = applyParsedQuery(explicit, {
      locationText: 'Kempten',
      role: 'Frontend Developer',
    });

    expect(result.locationText).toBe('Munich');
    expect(result.role).toBe('Backend Developer');
  });
});
