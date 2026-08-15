import { queryOne, query } from '@ejc/database';

import { analysisInputHash, PROMPT_VERSION, type ResearchResult } from './research';

/**
 * Persistence for research output (plan section 21).
 *
 * Cached so repeated "research this" clicks do not re-bill the provider, and
 * keyed by prompt version so a prompt change invalidates naturally rather than
 * serving stale analysis.
 */

export type AnalysisSubject = 'job' | 'company' | 'candidate' | 'query';

interface StoredAnalysis {
  output: {
    summary: string;
    strengths: string[];
    concerns: string[];
  };
  sources: Array<{ url: string; provider: string }>;
  provider: string;
  model: string;
  created_at: Date;
}

export interface CachedResearch extends ResearchResult {
  cachedAt: string;
}

export async function getCachedResearch(
  subjectType: AnalysisSubject,
  subjectId: string,
  inputHash: string,
): Promise<CachedResearch | undefined> {
  const row = await queryOne<StoredAnalysis>(
    `SELECT output, sources, provider, model, created_at
     FROM ai_analysis
     WHERE subject_type = $1 AND subject_id = $2 AND analysis_kind = 'research'
       AND prompt_version = $3 AND input_hash = $4
       AND (expires_at IS NULL OR expires_at > now())`,
    [subjectType, subjectId, PROMPT_VERSION, inputHash],
  );
  if (!row) return undefined;

  return {
    summary: row.output.summary,
    strengths: row.output.strengths ?? [],
    concerns: row.output.concerns ?? [],
    sources: row.sources ?? [],
    provider: row.provider,
    model: row.model,
    generated: row.provider !== 'none',
    cachedAt: row.created_at.toISOString(),
  };
}

export async function storeResearch(
  subjectType: AnalysisSubject,
  subjectId: string,
  inputHash: string,
  result: ResearchResult,
): Promise<void> {
  await query(
    `
      INSERT INTO ai_analysis (
        subject_type, subject_id, analysis_kind, prompt_version, provider, model,
        input_hash, output, sources
      ) VALUES ($1, $2, 'research', $3, $4, $5, $6, $7::jsonb, $8::jsonb)
      ON CONFLICT (subject_type, subject_id, analysis_kind, prompt_version, input_hash)
      DO UPDATE SET output = EXCLUDED.output, sources = EXCLUDED.sources
    `,
    [
      subjectType,
      subjectId,
      PROMPT_VERSION,
      result.provider,
      result.model,
      inputHash,
      JSON.stringify({
        summary: result.summary,
        strengths: result.strengths,
        concerns: result.concerns,
      }),
      JSON.stringify(result.sources),
    ],
  );
}

export { analysisInputHash };
