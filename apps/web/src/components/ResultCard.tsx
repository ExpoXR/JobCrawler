'use client';

import type { MatchEvidence, SearchResultItem } from '@ejc/shared';
import Link from 'next/link';

import { ScoreBadge } from './ScoreBadge';

/**
 * Result card (plan section 28).
 *
 * Active vacancies and potential employers use the same card but are made
 * unmistakably different (plan section 18): a coloured left edge, a distinct
 * badge, and different wording.
 */

const MARKERS: Record<MatchEvidence['kind'], string> = {
  match: '✓',
  partial: '△',
  miss: '✕',
  info: 'ℹ',
};

function formatDistance(distanceKm: number | undefined): string | undefined {
  if (distanceKm === undefined) return undefined;
  return distanceKm < 10 ? `${distanceKm.toFixed(1)} km away` : `${Math.round(distanceKm)} km away`;
}

function formatSalary(item: SearchResultItem): string | undefined {
  const job = item.job;
  if (!job?.salaryMin && !job?.salaryMax) return undefined;
  const currency = job.salaryCurrency ?? '';
  const period = job.salaryPeriod ? `/${job.salaryPeriod}` : '';
  if (job.salaryMin && job.salaryMax && job.salaryMin !== job.salaryMax) {
    return `${job.salaryMin.toLocaleString()}–${job.salaryMax.toLocaleString()} ${currency}${period}`.trim();
  }
  return `${(job.salaryMax ?? job.salaryMin ?? 0).toLocaleString()} ${currency}${period}`.trim();
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface ResultCardProps {
  item: SearchResultItem;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function ResultCard({ item, selected, onSelect }: ResultCardProps) {
  const isPotential = item.kind === 'potential_employer';
  const isCandidate = item.kind === 'candidate';

  const title = isCandidate
    ? (item.candidate?.publicName ?? item.candidate?.publicTitle ?? 'Public profile')
    : isPotential
      ? (item.company?.name ?? 'Company')
      : (item.job?.title ?? 'Vacancy');

  const subtitle = isCandidate
    ? item.candidate?.publicTitle
    : isPotential
      ? (item.company?.industry ?? 'Potential employer')
      : (item.company?.name ?? item.job?.companyName);

  const detailHref = isPotential
    ? `/companies/${item.company?.id ?? ''}`
    : isCandidate
      ? (item.candidate?.profileUrl ?? '#')
      : `/jobs/${item.job?.id ?? ''}`;

  const meta = [
    formatDistance(item.distanceKm),
    isCandidate
      ? item.candidate?.approximateLocation
      : (item.job?.city ?? item.company?.city),
    item.job?.workModel && item.job.workModel !== 'unknown' ? item.job.workModel : undefined,
    item.job?.employmentType && item.job.employmentType !== 'unknown'
      ? item.job.employmentType.replace('_', '-')
      : undefined,
    formatSalary(item),
    formatDate(item.job?.publishedAt),
  ].filter((entry): entry is string => Boolean(entry));

  const lastVerified = formatDate(
    item.job?.lastVerifiedAt ?? item.company?.lastVerifiedAt ?? item.candidate?.lastCheckedAt,
  );

  const evidence = item.match.evidence.slice(0, 7);
  const sourceHost = (() => {
    const url = item.job?.applicationUrl ?? item.job?.sources[0]?.url ?? item.company?.website;
    if (!url) return undefined;
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return undefined;
    }
  })();

  return (
    <li>
      <article
        className={`result-card${selected ? ' selected' : ''}${isPotential ? ' potential' : ''}`}
        onClick={() => onSelect(item.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(item.id);
          }
        }}
        tabIndex={0}
        role="button"
        aria-pressed={selected}
        aria-label={`${title}, ${Math.round(item.match.score)} percent match`}
      >
        <div className="result-head">
          <div>
            <h3 className="result-title">
              <Link href={detailHref} onClick={(event) => event.stopPropagation()}>
                {title}
              </Link>
            </h3>
            {subtitle ? <div className="result-company">{subtitle}</div> : null}
          </div>
          <ScoreBadge score={item.match.score} />
        </div>

        <div className="result-meta">
          {isPotential ? (
            <span className="badge potential">No active vacancy</span>
          ) : isCandidate ? (
            <span className="badge">Public profile</span>
          ) : (
            <span className="badge vacancy">Active vacancy</span>
          )}
          {meta.map((entry) => (
            <span key={entry}>{entry}</span>
          ))}
        </div>

        {evidence.length > 0 ? (
          <ul className="evidence-list">
            {evidence.map((entry, index) => (
              <li key={`${entry.component}-${entry.label}-${index}`} className={entry.kind}>
                <span className="marker" aria-hidden="true">
                  {MARKERS[entry.kind]}
                </span>
                <span>{entry.label}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="result-meta" style={{ marginTop: '0.5rem' }}>
          {sourceHost ? <span>Source: {sourceHost}</span> : null}
          {lastVerified ? <span>Verified {lastVerified}</span> : null}
          {item.job?.applicationUrl ? (
            <a
              href={item.job.applicationUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              onClick={(event) => event.stopPropagation()}
            >
              Open original posting ↗
            </a>
          ) : null}
          {isCandidate && item.candidate?.profileUrl ? (
            <a
              href={item.candidate.profileUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              onClick={(event) => event.stopPropagation()}
            >
              Open public profile ↗
            </a>
          ) : null}
        </div>
      </article>
    </li>
  );
}
