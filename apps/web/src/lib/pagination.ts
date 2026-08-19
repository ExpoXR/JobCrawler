/**
 * Result paging.
 *
 * Paging is client-side over the already-fetched result set. That set is bounded
 * server-side (`SEARCH_MAX_RESULTS`, plus a hard clamp of 500 in
 * `listSearchResults`), and the map plots every match rather than only the
 * visible page — so a round trip per page would cost more than it saves.
 */

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 25;

export function isPageSize(value: unknown): value is PageSize {
  return typeof value === 'number' && (PAGE_SIZES as readonly number[]).includes(value);
}

/** Always at least one page, so an empty result set still reads "page 1 of 1". */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamps a possibly stale page number to the range the result set supports. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize));
}

export interface PageRange {
  /** 1-based index of the first item shown, or 0 when there are none. */
  first: number;
  /** 1-based index of the last item shown, or 0 when there are none. */
  last: number;
}

export function pageRange(page: number, pageSize: number, total: number): PageRange {
  if (total === 0) return { first: 0, last: 0 };
  const clamped = clampPage(page, total, pageSize);
  return {
    first: (clamped - 1) * pageSize + 1,
    last: Math.min(clamped * pageSize, total),
  };
}
