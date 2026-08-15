import { listSearchResults } from '@ejc/database';
import type { SearchResultItem } from '@ejc/shared';

/**
 * Result export (plan section 31).
 *
 * No account required, and every row carries its source URLs so an exported
 * file remains verifiable away from the app.
 *
 * CSV and JSON are implemented here with no dependencies. XLSX and PDF are
 * deliberately left for Phase 8, where a rendering dependency is justified.
 */

export type ExportFormat = 'csv' | 'json';

export interface ExportOptions {
  limit?: number;
  minScore?: number;
}

const CSV_COLUMNS = [
  'score',
  'kind',
  'title',
  'company',
  'location',
  'distance_km',
  'work_model',
  'employment_type',
  'seniority',
  'salary_min',
  'salary_max',
  'salary_currency',
  'skills',
  'active_vacancy',
  'application_url',
  'source_urls',
  'last_verified',
  'match_explanation',
] as const;

/** RFC 4180 quoting, with the leading-character guard against CSV injection. */
export function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);

  // A cell starting with =, +, - or @ is executed as a formula by spreadsheet
  // applications. Prefixing a quote neutralises that without losing data.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function explanationOf(item: SearchResultItem): string {
  return item.match.evidence
    .map((entry) => {
      const marker = entry.kind === 'match' ? '+' : entry.kind === 'miss' ? '-' : '~';
      return `${marker} ${entry.label}`;
    })
    .join('; ');
}

function rowFor(item: SearchResultItem): Record<(typeof CSV_COLUMNS)[number], unknown> {
  const job = item.job;
  const company = item.company;
  const candidate = item.candidate;

  const sourceUrls = [
    ...(job?.sources.map((source) => source.url) ?? []),
    ...(candidate?.sources.map((source) => source.url) ?? []),
    company?.website,
  ].filter(Boolean);

  return {
    score: item.match.score,
    kind: item.kind,
    title: job?.title ?? candidate?.publicTitle ?? company?.name ?? '',
    company: company?.name ?? job?.companyName ?? '',
    location:
      job?.city ??
      candidate?.approximateLocation ??
      [company?.city, company?.country].filter(Boolean).join(', '),
    distance_km: item.distanceKm !== undefined ? Math.round(item.distanceKm) : '',
    work_model: job?.workModel ?? '',
    employment_type: job?.employmentType ?? '',
    seniority: job?.seniority ?? '',
    salary_min: job?.salaryMin ?? '',
    salary_max: job?.salaryMax ?? '',
    salary_currency: job?.salaryCurrency ?? '',
    skills: (job?.skills ?? candidate?.skills ?? company?.technologies ?? []).join(', '),
    active_vacancy: item.kind === 'job' ? 'yes' : 'no',
    application_url: job?.applicationUrl ?? candidate?.profileUrl ?? company?.careerPageUrl ?? '',
    source_urls: sourceUrls.join(' | '),
    last_verified: job?.lastVerifiedAt ?? company?.lastVerifiedAt ?? candidate?.lastCheckedAt ?? '',
    match_explanation: explanationOf(item),
  };
}

export function resultsToCsv(items: readonly SearchResultItem[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const item of items) {
    const row = rowFor(item);
    lines.push(CSV_COLUMNS.map((column) => toCsvValue(row[column])).join(','));
  }
  // Excel needs the BOM to read UTF-8 correctly — European names depend on it.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function resultsToJson(items: readonly SearchResultItem[], searchId: string): string {
  return JSON.stringify(
    {
      searchId,
      exportedAt: new Date().toISOString(),
      resultCount: items.length,
      results: items.map((item) => ({
        score: item.match.score,
        kind: item.kind,
        distanceKm: item.distanceKm,
        components: item.match.components,
        evidence: item.match.evidence,
        job: item.job,
        company: item.company,
        candidate: item.candidate,
      })),
    },
    null,
    2,
  );
}

export interface ExportPayload {
  body: string;
  contentType: string;
  filename: string;
}

export async function exportSearchResults(
  searchId: string,
  format: ExportFormat,
  options: ExportOptions = {},
): Promise<ExportPayload> {
  const items = await listSearchResults(searchId, {
    limit: options.limit ?? 500,
    ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
  });

  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return {
      body: resultsToJson(items, searchId),
      contentType: 'application/json; charset=utf-8',
      filename: `expojobcrawler-${stamp}.json`,
    };
  }

  return {
    body: resultsToCsv(items),
    contentType: 'text/csv; charset=utf-8',
    filename: `expojobcrawler-${stamp}.csv`,
  };
}
