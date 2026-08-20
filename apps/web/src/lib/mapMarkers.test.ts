import type { MatchResult, SearchResultItem } from '@ejc/shared';
import { describe, expect, it } from 'vitest';

import {
  MATCH_COLORS,
  labelOf,
  markerAriaLabel,
  markerTitle,
  matchColorToken,
  toMarkers,
  zoomForRadius,
} from './mapMarkers';

const match = (score: number): MatchResult => ({
  score,
  rejected: false,
  rejectionReasons: [],
  components: [],
  evidence: [],
});

function jobItem(id: string, coordinates?: { lat: number; lon: number }): SearchResultItem {
  return {
    id,
    kind: 'job',
    match: match(80),
    job: {
      id,
      title: 'React Developer',
      ...(coordinates ? { coordinates } : {}),
    } as SearchResultItem['job'],
  };
}

describe('toMarkers', () => {
  it('drops results with no coordinates anywhere', () => {
    const markers = toMarkers([jobItem('a', { lat: 47.7, lon: 10.3 }), jobItem('b')]);
    expect(markers.map((marker) => marker.id)).toEqual(['a']);
  });

  it('falls back from job coordinates to the company location', () => {
    const item: SearchResultItem = {
      id: 'c',
      kind: 'potential_employer',
      match: match(60),
      company: { id: 'c', name: 'Acme', location: { lat: 48, lon: 11 } } as SearchResultItem['company'],
    };
    expect(toMarkers([item])[0]?.point).toEqual({ lat: 48, lon: 11 });
  });
});

describe('labels', () => {
  it('names each kind by what it is', () => {
    expect(labelOf(jobItem('a', { lat: 1, lon: 1 }))).toBe('React Developer');
    expect(
      labelOf({ id: 'x', kind: 'potential_employer', match: match(10) }),
    ).toBe('Company');
    expect(labelOf({ id: 'x', kind: 'candidate', match: match(10) })).toBe('Public profile');
  });

  it('rounds the score for display', () => {
    const [marker] = toMarkers([{ ...jobItem('a', { lat: 1, lon: 1 }), match: match(72.4) }]);
    expect(marker && markerTitle(marker)).toBe('React Developer — 72%');
    expect(marker && markerAriaLabel(marker)).toBe('React Developer, 72 percent match');
  });
});

describe('match bands', () => {
  it('splits at 75 and 50', () => {
    expect(matchColorToken(75)).toBe(MATCH_COLORS.high);
    expect(matchColorToken(74.9)).toBe(MATCH_COLORS.medium);
    expect(matchColorToken(50)).toBe(MATCH_COLORS.medium);
    expect(matchColorToken(49.9)).toBe(MATCH_COLORS.low);
  });

  it('carries a literal fallback, because the Maps API cannot read CSS variables', () => {
    for (const token of Object.values(MATCH_COLORS)) {
      expect(token.fallback).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('zoomForRadius', () => {
  it('zooms out as the radius grows', () => {
    expect(zoomForRadius(10)).toBeGreaterThan(zoomForRadius(50));
    expect(zoomForRadius(50)).toBeGreaterThan(zoomForRadius(200));
  });
});
