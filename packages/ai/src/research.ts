import { createHash } from 'node:crypto';

import {
  type Company,
  getLogger,
  type Job,
  type MatchResult,
  type SearchQuery,
  type SourceReference,
  truncate,
} from '@ejc/shared';
import { z } from 'zod';

import { getAiProvider } from './providers';

/**
 * AI research agent (plan section 21).
 *
 * Two hard rules:
 *   1. The agent explains and researches; it never produces the match score.
 *      Scores come from `@ejc/matching` so they stay reproducible.
 *   2. Every claim must cite a source URL we actually fetched. The prompt is
 *      built only from material already in the database, and the response is
 *      validated against a schema before anything is shown to a user.
 */

export const PROMPT_VERSION = 'v1';

const researchOutputSchema = z.object({
  summary: z.string().max(2000),
  strengths: z.array(z.string().max(300)).max(8).default([]),
  concerns: z.array(z.string().max(300)).max(8).default([]),
  /** Indexes into the source list handed to the model. */
  citedSources: z.array(z.number().int().min(0).max(50)).max(20).default([]),
});

export type ResearchOutput = z.infer<typeof researchOutputSchema>;

export interface ResearchResult {
  summary: string;
  strengths: string[];
  concerns: string[];
  sources: SourceReference[];
  provider: string;
  model: string;
  /** True when no AI provider was available and this is a rule-based summary. */
  generated: boolean;
}

function collectSources(job: Job | undefined, company: Company | undefined): SourceReference[] {
  const sources: SourceReference[] = [];
  const seen = new Set<string>();

  const push = (url: string | undefined, provider: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, provider });
  };

  for (const source of job?.sources ?? []) push(source.url, source.provider);
  push(job?.applicationUrl, 'job');
  push(company?.website, 'company-website');
  push(company?.careerPageUrl, 'career-page');
  for (const source of company?.sources ?? []) push(source.url, source.provider);

  return sources.slice(0, 20);
}

/**
 * Deterministic explanation built from the match components.
 *
 * This is what users see when no AI provider is configured — and it is a real
 * feature, not a placeholder: the scoring evidence already says why a result
 * ranked where it did.
 */
export function explainMatchWithoutAi(
  match: MatchResult,
  job: Job | undefined,
  company: Company | undefined,
  /**
   * False when the caller had no user query to score against — opening a result
   * directly, rather than from a search. Quoting a percentage there would be
   * meaningless, because there are no requirements to score against.
   */
  hasQueryContext = true,
): ResearchResult {
  const strengths = match.evidence
    .filter((entry) => entry.kind === 'match')
    .map((entry) => entry.label)
    .slice(0, 8);

  const concerns = match.evidence
    .filter((entry) => entry.kind === 'miss' || entry.kind === 'partial')
    .map((entry) => entry.label)
    .slice(0, 8);

  const subject = job?.title ?? company?.name ?? 'This result';
  const at = company?.name && job ? ` at ${company.name}` : '';

  const summary =
    (hasQueryContext ? `${subject}${at} scored ${match.score}%. ` : `${subject}${at}. `) +
    (strengths.length > 0 ? `Matching signals: ${strengths.join(', ')}. ` : '') +
    (concerns.length > 0 ? `Gaps: ${concerns.join(', ')}.` : '') +
    (hasQueryContext
      ? ''
      : ' Open this result from a search to see it scored against your requirements.');

  return {
    summary: summary.trim(),
    strengths,
    concerns,
    sources: collectSources(job, company),
    provider: 'none',
    model: '',
    generated: false,
  };
}

const RESEARCH_SYSTEM_PROMPT = `You analyse an employment opportunity for a job seeker.
You are given facts collected from public web sources, each with an index.
Rules:
- Use only the supplied facts. Never invent companies, jobs, people, or numbers.
- If a fact is missing, say it is unknown rather than guessing.
- Do not produce a match score; a scoring engine already did that.
- Reply with one JSON object: {"summary": string, "strengths": string[],
  "concerns": string[], "citedSources": number[]}
- citedSources must contain the indexes of sources that support your statements.`;

function buildFactSheet(
  query: SearchQuery,
  job: Job | undefined,
  company: Company | undefined,
  sources: SourceReference[],
): string {
  const lines: string[] = [];

  lines.push('## What the job seeker wants');
  lines.push(`Role: ${query.role || 'unspecified'}`);
  lines.push(`Location: ${query.locationText} (within ${query.radiusKm} km)`);
  if (query.requiredSkills.length) lines.push(`Required: ${query.requiredSkills.join(', ')}`);
  if (query.preferredSkills.length) lines.push(`Preferred: ${query.preferredSkills.join(', ')}`);
  if (query.workModels.length) lines.push(`Work models: ${query.workModels.join(', ')}`);

  if (company) {
    lines.push('', '## Company facts');
    lines.push(`Name: ${company.name}`);
    if (company.industry) lines.push(`Industry: ${company.industry}`);
    if (company.city) lines.push(`Location: ${[company.city, company.country].filter(Boolean).join(', ')}`);
    if (company.technologies.length) lines.push(`Technologies: ${company.technologies.join(', ')}`);
    if (company.services.length) lines.push(`Services: ${company.services.join(', ')}`);
    if (company.description) lines.push(`Description: ${truncate(company.description, 1200)}`);
    lines.push(`Active vacancies on record: ${company.activeJobCount}`);
  }

  if (job) {
    lines.push('', '## Job facts');
    lines.push(`Title: ${job.title}`);
    if (job.city) lines.push(`Location: ${[job.city, job.country].filter(Boolean).join(', ')}`);
    if (job.workModel !== 'unknown') lines.push(`Work model: ${job.workModel}`);
    if (job.employmentType !== 'unknown') lines.push(`Employment type: ${job.employmentType}`);
    if (job.seniority !== 'unknown') lines.push(`Seniority: ${job.seniority}`);
    if (job.skills.length) lines.push(`Skills mentioned: ${job.skills.join(', ')}`);
    if (job.requiredExperienceYears !== undefined) {
      lines.push(`Experience required: ${job.requiredExperienceYears} years`);
    }
    if (job.salaryMin || job.salaryMax) {
      lines.push(
        `Salary: ${job.salaryMin ?? '?'}–${job.salaryMax ?? '?'} ${job.salaryCurrency ?? ''}`.trim(),
      );
    }
    if (job.description) lines.push(`Description: ${truncate(job.description, 4000)}`);
  }

  lines.push('', '## Sources');
  sources.forEach((source, index) => lines.push(`[${index}] ${source.url}`));

  return lines.join('\n');
}

export interface ResearchOptions {
  signal?: AbortSignal;
  /** False when there is no user query behind the request. */
  hasQueryContext?: boolean;
}

/**
 * Produces an explanation for one result, with provenance.
 *
 * Falls back to `explainMatchWithoutAi` on any failure, so this function always
 * returns something usable.
 */
export async function researchOpportunity(
  query: SearchQuery,
  match: MatchResult,
  job: Job | undefined,
  company: Company | undefined,
  options: ResearchOptions = {},
): Promise<ResearchResult> {
  const provider = getAiProvider();
  const sources = collectSources(job, company);
  const hasQueryContext = Boolean(options.hasQueryContext ?? true);

  if (!provider.configured) {
    return explainMatchWithoutAi(match, job, company, hasQueryContext);
  }

  try {
    const factSheet = buildFactSheet(query, job, company, sources);
    const completion = await provider.complete({
      messages: [
        { role: 'system', content: RESEARCH_SYSTEM_PROMPT },
        { role: 'user', content: factSheet },
      ],
      json: true,
      temperature: 0.2,
      maxTokens: 1200,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const parsed = parseResearchOutput(completion.text);
    if (!parsed) return explainMatchWithoutAi(match, job, company, hasQueryContext);

    const cited = parsed.citedSources
      .map((index) => sources[index])
      .filter((source): source is SourceReference => source !== undefined);

    return {
      summary: parsed.summary,
      strengths: parsed.strengths,
      concerns: parsed.concerns,
      sources: cited.length > 0 ? cited : sources,
      provider: completion.provider,
      model: completion.model,
      generated: true,
    };
  } catch (error) {
    getLogger('ai').warn('Research failed; falling back to rule-based explanation', {
      provider: provider.key,
      errorType: 'ai_failure',
      message: error instanceof Error ? error.message : String(error),
    });
    return explainMatchWithoutAi(match, job, company, hasQueryContext);
  }
}

export function parseResearchOutput(text: string): ResearchOutput | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  let candidate: unknown;
  try {
    candidate = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }

  const parsed = researchOutputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** Stable key for caching an analysis in `ai_analysis`. */
export function analysisInputHash(...parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex');
}

const SUMMARY_SYSTEM_PROMPT = `Summarise the supplied job posting in at most three sentences.
Use only the given text. Do not invent details. Reply with plain text only.`;

/** Short neutral summary of a posting, used on result cards. */
export async function summarizeJob(
  job: Job,
  options: ResearchOptions = {},
): Promise<string | undefined> {
  const provider = getAiProvider();
  if (!provider.configured || !job.description) return undefined;

  try {
    const completion = await provider.complete({
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: truncate(`${job.title}\n\n${job.description}`, 6000) },
      ],
      temperature: 0.1,
      maxTokens: 300,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = completion.text.trim();
    return text.length > 0 ? truncate(text, 1000) : undefined;
  } catch {
    return undefined;
  }
}
