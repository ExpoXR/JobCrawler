'use client';

import type { SearchMode, SearchProgress, SearchQuery, SearchResultItem } from '@ejc/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FilterPanel } from './FilterPanel';
import { ResultCard } from './ResultCard';
import { ResultMap } from './ResultMap';

/**
 * The three-column search workspace (plan section 26).
 *
 * State flow:
 *   filters → POST /api/search → searchId → SSE progress → poll results
 *
 * Results and map share one selection so the two stay synchronised, which the
 * plan calls out explicitly.
 */

function emptyQuery(mode: SearchMode): SearchQuery {
  return {
    mode,
    locationText: '',
    radiusKm: 50,
    role: '',
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
    includePotentialEmployers: mode === 'jobs',
    minMatchScore: 0,
  };
}

interface ParseResponse {
  parsed: Record<string, unknown>;
  usedAi: boolean;
}

export function SearchWorkspace({ mode }: { mode: SearchMode }) {
  const [query, setQuery] = useState<SearchQuery>(() => emptyQuery(mode));
  const [naturalLanguage, setNaturalLanguage] = useState('');
  const [searchId, setSearchId] = useState<string | undefined>();
  const [progress, setProgress] = useState<SearchProgress | undefined>();
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const eventSourceRef = useRef<EventSource | null>(null);

  const loadResults = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/search/${id}?limit=200&minScore=0`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        progress: SearchProgress;
        results: SearchResultItem[];
      };
      setProgress(payload.progress);
      setResults(payload.results);
    } catch {
      // Transient network errors are expected while a search is running; the
      // next progress tick will retry.
    }
  }, []);

  // Follow progress over SSE and refresh results whenever the stage advances.
  useEffect(() => {
    if (!searchId) return;

    void loadResults(searchId);

    const source = new EventSource(`/api/search/${searchId}/events`);
    eventSourceRef.current = source;

    let lastStage = '';
    source.addEventListener('progress', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as SearchProgress;
      setProgress(payload);
      if (payload.stage !== lastStage) {
        lastStage = payload.stage;
        void loadResults(searchId);
      }
    });

    source.addEventListener('done', () => {
      void loadResults(searchId);
      setBusy(false);
      source.close();
    });

    source.onerror = () => {
      // The stream ends when the search finishes; fall back to one final poll.
      source.close();
      setBusy(false);
      void loadResults(searchId);
    };

    return () => {
      source.close();
      eventSourceRef.current = null;
    };
  }, [searchId, loadResults]);

  const runSearch = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    setResults([]);
    setProgress(undefined);
    eventSourceRef.current?.close();

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          ...(naturalLanguage.trim() ? { naturalLanguage } : {}),
        }),
      });

      const payload = (await response.json()) as
        | { searchId: string; query: SearchQuery }
        | { error: string };

      if (!response.ok || !('searchId' in payload)) {
        setError('error' in payload ? payload.error : 'Search failed');
        setBusy(false);
        return;
      }

      // The server may have enriched the query (geocoding, parsed filters);
      // reflect that back into the panel so what is shown is what ran.
      setQuery(payload.query);
      setSearchId(payload.searchId);
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
  }, [query, naturalLanguage]);

  const applyNaturalLanguage = useCallback(async () => {
    if (!naturalLanguage.trim()) return;
    setParsing(true);
    setError(undefined);
    try {
      const response = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: naturalLanguage, mode }),
      });
      if (!response.ok) {
        setError('Could not parse that description.');
        return;
      }
      const payload = (await response.json()) as ParseResponse;
      const parsed = payload.parsed as Partial<SearchQuery> & { locationText?: string };

      setQuery((current) => ({
        ...current,
        ...parsed,
        mode: current.mode,
        locationText: parsed.locationText ?? current.locationText,
        requiredSkills: parsed.requiredSkills ?? current.requiredSkills,
        preferredSkills: parsed.preferredSkills ?? current.preferredSkills,
        technologies: parsed.technologies ?? current.technologies,
        industries: parsed.industries ?? current.industries,
        languages: parsed.languages ?? current.languages,
        companySizes: parsed.companySizes ?? current.companySizes,
        keywords: parsed.keywords ?? current.keywords,
        exclusions: parsed.exclusions ?? current.exclusions,
        employmentTypes: parsed.employmentTypes ?? current.employmentTypes,
        workModels: parsed.workModels ?? current.workModels,
      }));
    } catch {
      setError('Could not parse that description.');
    } finally {
      setParsing(false);
    }
  }, [naturalLanguage, mode]);

  const center = query.location;
  const visibleResults = useMemo(
    () => results.filter((item) => item.match.score >= query.minMatchScore),
    [results, query.minMatchScore],
  );

  const jobCount = visibleResults.filter((item) => item.kind === 'job').length;
  const potentialCount = visibleResults.filter(
    (item) => item.kind === 'potential_employer',
  ).length;
  const candidateCount = visibleResults.filter((item) => item.kind === 'candidate').length;

  return (
    <div className="search-layout">
      <details className="filter-disclosure" open>
        <summary>
          Search filters
          <span>{query.locationText || 'Choose location'}</span>
        </summary>
        <FilterPanel
          query={query}
          onChange={setQuery}
          onSubmit={() => void runSearch()}
          busy={busy}
        />
      </details>

      <section aria-label="Results">
        <div className="panel query-panel">
          <div className="field query-field">
            <label htmlFor="nl-query">
              {mode === 'candidates'
                ? 'Describe the role, or paste a job description'
                : 'Describe what you are looking for'}
            </label>
            <textarea
              id="nl-query"
              value={naturalLanguage}
              placeholder={
                mode === 'candidates'
                  ? 'We need a frontend developer in Kempten who knows React and TypeScript…'
                  : 'Find frontend developer jobs within 40 km of Kempten. I know React, Next.js, TypeScript…'
              }
              onChange={(event) => setNaturalLanguage(event.target.value)}
            />
            <p className="hint">
              Parsed filters appear in the panel on the left and stay editable before you search.
            </p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => void applyNaturalLanguage()}
            disabled={parsing || !naturalLanguage.trim()}
          >
            {parsing ? 'Parsing…' : 'Parse into filters'}
          </button>
        </div>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        {progress ? (
          <div className="progress" role="status" aria-live="polite">
            <div className="progress-head">
              <span>{progress.message}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="progress-bar">
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            {progress.errors.length > 0 ? (
              <p className="hint progress-errors">
                Some sources were unavailable: {progress.errors.slice(0, 3).join(', ')}
              </p>
            ) : null}
          </div>
        ) : null}

        {visibleResults.length > 0 ? (
          <div className="result-meta result-summary">
            <strong>{visibleResults.length} results</strong>
            {jobCount > 0 ? <span>{jobCount} vacancies</span> : null}
            {potentialCount > 0 ? <span>{potentialCount} potential employers</span> : null}
            {candidateCount > 0 ? <span>{candidateCount} profiles</span> : null}
            {searchId ? (
              <>
                <a href={`/api/export?searchId=${searchId}&format=csv`}>Export CSV</a>
                <a href={`/api/export?searchId=${searchId}&format=json`}>Export JSON</a>
              </>
            ) : null}
          </div>
        ) : null}

        {visibleResults.length === 0 ? (
          <div className="empty-state">
            {busy
              ? 'Searching…'
              : searchId
                ? 'No results matched these filters yet. Try widening the radius or lowering the minimum match.'
                : 'Enter a location and press Search.'}
          </div>
        ) : (
          <ul className="result-list">
            {visibleResults.map((item) => (
              <ResultCard
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={setSelectedId}
              />
            ))}
          </ul>
        )}
      </section>

      <aside className="map-column" aria-label="Map">
        {center ? (
          <ResultMap
            center={center}
            radiusKm={query.radiusKm}
            items={visibleResults}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <div className="map-container">
            <div className="map-fallback">The map appears once a location has been resolved.</div>
          </div>
        )}
      </aside>
    </div>
  );
}
