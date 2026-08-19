'use client';

import type { EmploymentType, SearchQuery, Seniority, WorkModel } from '@ejc/shared';
import { useId, useMemo } from 'react';

/**
 * Filter panel (plan section 30).
 *
 * Every filter is a controlled field on one `SearchQuery` object, so what the
 * user sees is exactly what gets sent — including filters the natural-language
 * parser filled in, which stay visible and editable (plan section 6).
 *
 * Layout is three bands: a fixed head, a scrolling body, and a fixed footer that
 * keeps Search reachable however long the form grows. Only the body scrolls, and
 * it contains its own overscroll so the wheel does not chain into the results
 * column behind it.
 */

export interface FilterPanelProps {
  query: SearchQuery;
  onChange: (next: SearchQuery) => void;
  onSubmit: () => void;
  onReset: () => void;
  busy: boolean;
  disabled?: boolean;
}

const WORK_MODELS: Array<{ value: WorkModel; label: string }> = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
];

const EMPLOYMENT_TYPES: Array<{ value: EmploymentType; label: string }> = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contract', label: 'Contract' },
  { value: 'freelance', label: 'Freelance' },
  { value: 'internship', label: 'Internship' },
];

const SENIORITIES: Seniority[] = ['junior', 'mid', 'senior', 'lead', 'principal'];

const DEFAULT_RADIUS_KM = 50;

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

/**
 * How many filters narrow the search beyond its defaults.
 *
 * Location is excluded: it is the subject of the search, not a filter on it.
 */
function countActiveFilters(query: SearchQuery): number {
  const lists = [
    query.requiredSkills,
    query.preferredSkills,
    query.technologies,
    query.industries,
    query.exclusions,
    query.employmentTypes,
    query.workModels,
  ];

  const flags = [
    query.role.trim().length > 0,
    query.seniority !== undefined,
    query.minExperienceYears !== undefined,
    query.salaryMin !== undefined,
    query.minMatchScore > 0,
    query.radiusKm !== DEFAULT_RADIUS_KM,
  ];

  return lists.filter((list) => list.length > 0).length + flags.filter(Boolean).length;
}

export function FilterPanel({
  query,
  onChange,
  onSubmit,
  onReset,
  busy,
  disabled,
}: FilterPanelProps) {
  const id = useId();
  const isCandidateMode = query.mode === 'candidates';
  const patch = (changes: Partial<SearchQuery>) => onChange({ ...query, ...changes });
  const activeFilters = useMemo(() => countActiveFilters(query), [query]);

  return (
    <form
      className="panel filters-column"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="filters-head">
        <h2>
          Filters
          {activeFilters > 0 ? (
            <span className="filters-count" aria-label={`${activeFilters} active`}>
              {activeFilters}
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          className="link-button"
          onClick={onReset}
          disabled={activeFilters === 0 || busy}
        >
          Reset
        </button>
      </div>

      <div className="filters-body">
        <div className="field">
          <label htmlFor={`${id}-location`}>Location *</label>
          <input
            id={`${id}-location`}
            type="text"
            required
            value={query.locationText}
            placeholder="Kempten, Germany"
            onChange={(event) => patch({ locationText: event.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor={`${id}-radius`}>Radius: {query.radiusKm} km</label>
          <input
            id={`${id}-radius`}
            type="range"
            min={5}
            max={250}
            step={5}
            value={query.radiusKm}
            className="range-control"
            onChange={(event) => patch({ radiusKm: Number(event.target.value) })}
          />
        </div>

        <details className="filter-group" open>
          <summary>Role and skills</summary>

          <div className="field">
            <label htmlFor={`${id}-role`}>
              {isCandidateMode ? 'Role to fill' : 'Desired role'}
            </label>
            <input
              id={`${id}-role`}
              type="text"
              value={query.role}
              placeholder="React / Next.js Developer"
              onChange={(event) => patch({ role: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-required`}>Required skills (hard requirement)</label>
            <input
              id={`${id}-required`}
              type="text"
              value={query.requiredSkills.join(', ')}
              placeholder="React, TypeScript"
              onChange={(event) => patch({ requiredSkills: parseList(event.target.value) })}
            />
            <p className="hint">A result missing any of these is rejected, not just downranked.</p>
          </div>

          <div className="field">
            <label htmlFor={`${id}-preferred`}>Preferred skills</label>
            <input
              id={`${id}-preferred`}
              type="text"
              value={query.preferredSkills.join(', ')}
              placeholder="Next.js, WordPress"
              onChange={(event) => patch({ preferredSkills: parseList(event.target.value) })}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-seniority`}>Seniority</label>
            <select
              id={`${id}-seniority`}
              value={query.seniority ?? ''}
              onChange={(event) =>
                patch({
                  seniority: event.target.value ? (event.target.value as Seniority) : undefined,
                })
              }
            >
              <option value="">Any</option>
              {SENIORITIES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor={`${id}-experience`}>Years of experience</label>
            <input
              id={`${id}-experience`}
              type="number"
              min={0}
              max={50}
              value={query.minExperienceYears ?? ''}
              onChange={(event) =>
                patch({
                  minExperienceYears: event.target.value ? Number(event.target.value) : undefined,
                })
              }
            />
          </div>
        </details>

        <details className="filter-group" open>
          <summary>Working arrangement</summary>

          <fieldset className="field fieldset-reset">
            <legend>Work model</legend>
            {WORK_MODELS.map((entry) => (
              <label className="checkbox-row" key={entry.value}>
                <input
                  type="checkbox"
                  checked={query.workModels.includes(entry.value)}
                  onChange={() => patch({ workModels: toggle(query.workModels, entry.value) })}
                />
                {entry.label}
              </label>
            ))}
          </fieldset>

          {!isCandidateMode ? (
            <fieldset className="field fieldset-reset">
              <legend>Employment type</legend>
              {EMPLOYMENT_TYPES.map((entry) => (
                <label className="checkbox-row" key={entry.value}>
                  <input
                    type="checkbox"
                    checked={query.employmentTypes.includes(entry.value)}
                    onChange={() =>
                      patch({ employmentTypes: toggle(query.employmentTypes, entry.value) })
                    }
                  />
                  {entry.label}
                </label>
              ))}
            </fieldset>
          ) : null}

          {!isCandidateMode ? (
            <div className="field">
              <label htmlFor={`${id}-salary`}>Minimum salary</label>
              <input
                id={`${id}-salary`}
                type="number"
                min={0}
                step={1000}
                value={query.salaryMin ?? ''}
                placeholder="60000"
                onChange={(event) =>
                  patch({ salaryMin: event.target.value ? Number(event.target.value) : undefined })
                }
              />
            </div>
          ) : null}
        </details>

        <details className="filter-group" open>
          <summary>Scope and scoring</summary>

          <div className="field">
            <label htmlFor={`${id}-industry`}>Industry</label>
            <input
              id={`${id}-industry`}
              type="text"
              value={query.industries.join(', ')}
              placeholder="Agency, Software"
              onChange={(event) => patch({ industries: parseList(event.target.value) })}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-exclusions`}>Exclude</label>
            <input
              id={`${id}-exclusions`}
              type="text"
              value={query.exclusions.join(', ')}
              placeholder="recruiting agency, call center"
              onChange={(event) => patch({ exclusions: parseList(event.target.value) })}
            />
          </div>

          <div className="field">
            <label htmlFor={`${id}-minscore`}>Minimum match: {query.minMatchScore}%</label>
            <input
              id={`${id}-minscore`}
              type="range"
              min={0}
              max={95}
              step={5}
              value={query.minMatchScore}
              className="range-control"
              onChange={(event) => patch({ minMatchScore: Number(event.target.value) })}
            />
          </div>

          {!isCandidateMode ? (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={query.includePotentialEmployers}
                onChange={(event) => patch({ includePotentialEmployers: event.target.checked })}
              />
              Include companies without active vacancies
            </label>
          ) : null}
        </details>
      </div>

      <div className="filters-foot">
        <button
          className="button full"
          type="submit"
          disabled={busy || disabled || !query.locationText.trim()}
          data-search-submit
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>
    </form>
  );
}
