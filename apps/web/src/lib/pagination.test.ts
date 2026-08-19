import { describe, expect, it } from 'vitest';

import {
  clampPage,
  DEFAULT_PAGE_SIZE,
  isPageSize,
  PAGE_SIZES,
  pageCount,
  pageRange,
} from './pagination';

describe('PAGE_SIZES', () => {
  it('offers the four documented sizes', () => {
    expect(PAGE_SIZES).toEqual([10, 25, 50, 100]);
  });

  it('defaults to one of them', () => {
    expect(isPageSize(DEFAULT_PAGE_SIZE)).toBe(true);
  });
});

describe('isPageSize', () => {
  it('accepts a supported size', () => {
    expect(isPageSize(10)).toBe(true);
    expect(isPageSize(100)).toBe(true);
  });

  it('rejects anything else', () => {
    // A stale or hand-edited localStorage value must not become a page size.
    expect(isPageSize(20)).toBe(false);
    expect(isPageSize(0)).toBe(false);
    expect(isPageSize(-10)).toBe(false);
    expect(isPageSize(Number.NaN)).toBe(false);
    expect(isPageSize('25')).toBe(false);
    expect(isPageSize(null)).toBe(false);
    expect(isPageSize(undefined)).toBe(false);
  });
});

describe('pageCount', () => {
  it('rounds a partial page up', () => {
    expect(pageCount(137, 25)).toBe(6);
  });

  it('divides evenly without a trailing empty page', () => {
    expect(pageCount(100, 25)).toBe(4);
  });

  it('reports one page for an empty result set', () => {
    expect(pageCount(0, 25)).toBe(1);
  });

  it('never divides by zero', () => {
    expect(pageCount(50, 0)).toBe(1);
  });
});

describe('clampPage', () => {
  it('leaves a valid page alone', () => {
    expect(clampPage(3, 137, 25)).toBe(3);
  });

  it('pulls back a page beyond the end', () => {
    // The case that strands a reader: results shrink while they are on page 6.
    expect(clampPage(6, 30, 25)).toBe(2);
  });

  it('floors at the first page', () => {
    expect(clampPage(0, 137, 25)).toBe(1);
    expect(clampPage(-4, 137, 25)).toBe(1);
  });
});

describe('pageRange', () => {
  it('describes a full page', () => {
    expect(pageRange(2, 25, 137)).toEqual({ first: 26, last: 50 });
  });

  it('stops the last page at the total', () => {
    expect(pageRange(6, 25, 137)).toEqual({ first: 126, last: 137 });
  });

  it('collapses to zero when there is nothing to show', () => {
    expect(pageRange(1, 25, 0)).toEqual({ first: 0, last: 0 });
  });

  it('clamps a stale page before computing the range', () => {
    expect(pageRange(9, 25, 30)).toEqual({ first: 26, last: 30 });
  });
});
