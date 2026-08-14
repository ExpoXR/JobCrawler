import {
  buildCandidateEmbeddingText,
  buildCompanyEmbeddingText,
  buildJobEmbeddingText,
  embedText,
  isEmbeddingEnabled,
  researchOpportunity,
  summarizeJob,
} from '@ejc/ai';
import {
  getCandidateById,
  getCompanyById,
  getJobById,
  getSearchSession,
  query as dbQuery,
  setJobEmbedding,
} from '@ejc/database';
import { createWorker, type WorkerHandle } from '@ejc/queue';
import { getLogger } from '@ejc/shared';

/**
 * Enrichment workers: embeddings, summaries and research.
 *
 * All of these are optional improvements layered on top of results that are
 * already usable, so every handler degrades quietly when no AI provider is
 * configured rather than failing the job.
 */

const logger = getLogger('worker');

export function registerEnrichmentWorkers(): WorkerHandle[] {
  const embedding = createWorker('embedding', async (job) => {
    if (!isEmbeddingEnabled()) return;

    const { subjectType, subjectId } = job.data;

    if (subjectType === 'job') {
      const target = await getJobById(subjectId);
      if (!target) return;
      const company = target.companyId ? await getCompanyById(target.companyId) : undefined;
      const vector = await embedText(buildJobEmbeddingText(target, company));
      if (vector) await setJobEmbedding(subjectId, vector);
      return;
    }

    if (subjectType === 'company') {
      const company = await getCompanyById(subjectId);
      if (!company) return;
      const vector = await embedText(buildCompanyEmbeddingText(company));
      if (vector) {
        await dbQuery(`UPDATE companies SET embedding = $2::vector WHERE id = $1`, [
          subjectId,
          `[${vector.join(',')}]`,
        ]);
      }
      return;
    }

    const candidate = await getCandidateById(subjectId);
    if (!candidate) return;
    const vector = await embedText(buildCandidateEmbeddingText(candidate));
    if (vector) {
      await dbQuery(`UPDATE candidates SET embedding = $2::vector WHERE id = $1`, [
        subjectId,
        `[${vector.join(',')}]`,
      ]);
    }
  });

  const aiAnalysis = createWorker('ai-analysis', async (job) => {
    const { resultId } = job.data;
    const target = await getJobById(resultId);
    if (!target) return;

    const summary = await summarizeJob(target);
    if (summary) {
      await dbQuery(`UPDATE jobs SET ai_summary = $2 WHERE id = $1`, [resultId, summary]);
    }
  });

  const research = createWorker('research', async (job) => {
    const { searchId, jobId, companyId } = job.data;

    const session = await getSearchSession(searchId);
    if (!session) return;

    const target = jobId ? await getJobById(jobId) : undefined;
    const company = companyId
      ? await getCompanyById(companyId)
      : target?.companyId
        ? await getCompanyById(target.companyId)
        : undefined;

    if (!target && !company) return;

    const result = await researchOpportunity(
      session.query,
      { score: 0, rejected: false, rejectionReasons: [], components: [], evidence: [] },
      target,
      company,
    );

    // Cached so repeated "research this" clicks do not re-bill the provider.
    await dbQuery(
      `
        INSERT INTO ai_analysis (
          subject_type, subject_id, analysis_kind, provider, model, input_hash, output, sources
        ) VALUES ($1, $2, 'research', $3, $4, $5, $6::jsonb, $7::jsonb)
        ON CONFLICT (subject_type, subject_id, analysis_kind, prompt_version, input_hash)
        DO UPDATE SET output = EXCLUDED.output, sources = EXCLUDED.sources
      `,
      [
        target ? 'job' : 'company',
        target?.id ?? company?.id ?? '',
        result.provider,
        result.model,
        `${searchId}:${target?.id ?? company?.id ?? ''}`,
        JSON.stringify({
          summary: result.summary,
          strengths: result.strengths,
          concerns: result.concerns,
        }),
        JSON.stringify(result.sources),
      ],
    ).catch((error: unknown) => {
      logger.warn('Failed to cache research output', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const normalization = createWorker('data-normalization', async (job) => {
    // Normalisation currently happens inline during extraction; this queue is
    // the seam for heavier passes (title canonicalisation, skill clustering).
    logger.debug('Normalization requested', { searchId: job.data.searchId });
  });

  return [embedding, aiAnalysis, research, normalization];
}
