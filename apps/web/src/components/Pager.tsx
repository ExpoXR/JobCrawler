'use client';

import { PAGE_SIZES, type PageSize, pageCount, pageRange } from '../lib/pagination';

/** Page controls for the result list. The maths lives in `lib/pagination`. */

export interface PagerProps {
  /** Number of results after filtering, across all pages. */
  total: number;
  page: number;
  pageSize: PageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
  id?: string;
}

export function Pager({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  id = 'pager',
}: PagerProps) {
  const pages = pageCount(total, pageSize);
  const { first, last } = pageRange(page, pageSize, total);

  return (
    <nav className="pager" aria-label="Result pages">
      <div className="pager-size">
        <label htmlFor={`${id}-size`}>Per page</label>
        <select
          id={`${id}-size`}
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value) as PageSize)}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <p className="pager-status" role="status" aria-live="polite">
        {total === 0 ? 'No results' : `Showing ${first}–${last} of ${total}`}
      </p>

      <div className="pager-controls">
        <button
          type="button"
          className="button secondary pager-step"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span className="pager-position">
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className="button secondary pager-step"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pages}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
