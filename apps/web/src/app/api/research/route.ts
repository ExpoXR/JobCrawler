import {
  analysisInputHash,
  getCachedResearch,
  researchOpportunity,
  storeResearch,
} from '@ejc/ai';
import { getCompanyById, getJobById, getSearchSession } from '@ejc/database';
import { parseSearchQuery, type SearchQuery } from '@ejc/shared';
import { scoreJob, scorePotentialEmployer } from '@ejc/matching';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { clientKey, handleRouteError, jsonError, rateLimit, readJsonBody, tooManyRequests } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * On-demand deeper analysis of one result (plan section 21).
 *
 * The score is *not* produced here — it is recomputed by `@ejc/matching` and
 * handed to the agent as context, so the explanation always describes the same
 * number the ranking used.
 */

const requestSchema = z
  .object({
    jobId: z.uuid().optional(),
    companyId: z.uuid().optional(),
    /** Supplies the query the result was found for; improves the analysis. */
    searchId: z.uuid().optional(),
    /** Skip the cache and ask the provider again. */
    refresh: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.jobId ?? value.companyId), {
    message: 'Either jobId or companyId is required',
  });

/** Falls back to a minimal query when the search session has expired. */
function fallbackQuery(locationText: string): SearchQuery {
  return parseSearchQuery({ mode: 'jobs', locationText: locationText || 'unknown' });
}

export async function POST(request: Request) {
  try {
    // Research can call a paid provider, so it is the most tightly limited route.
    const limit = rateLimit(clientKey(request, 'research'), 6, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const body = requestSchema.parse(await readJsonBody(request));

    const job = body.jobId ? await getJobById(body.jobId) : undefined;
    if (body.jobId && !job) return jsonError(404, 'Job not found');

    const companyId = body.companyId ?? job?.companyId;
    const company = companyId ? await getCompanyById(companyId) : undefined;
    if (!job && !company) return jsonError(404, 'Nothing to research');

    const session = body.searchId ? await getSearchSession(body.searchId) : undefined;
    const hasQueryContext = Boolean(session?.query);
    const query =
      session?.query ?? fallbackQuery(company?.city ?? job?.city ?? job?.location ?? '');

    // Recompute the score so the explanation matches the ranking.
    const match = job
      ? scoreJob(query, job, company)
      : scorePotentialEmployer(query, company!);

    const subjectType = job ? 'job' : 'company';
    const subjectId = job?.id ?? company?.id ?? '';
    const inputHash = analysisInputHash(
      subjectId,
      job?.lastVerifiedAt ?? company?.lastCrawledAt ?? '',
      query.role,
      query.requiredSkills.join(','),
      query.preferredSkills.join(','),
    );

    if (!body.refresh) {
      const cached = await getCachedResearch(subjectType, subjectId, inputHash);
      if (cached) {
        return NextResponse.json({
          research: cached,
          score: match.score,
          hasQueryContext,
          cached: true,
        });
      }
    }

    const research = await researchOpportunity(query, match, job, company, { hasQueryContext });

    // A cache write failure must not lose the analysis the user just paid for.
    await storeResearch(subjectType, subjectId, inputHash, research).catch(() => undefined);

    return NextResponse.json({ research, score: match.score, hasQueryContext, cached: false });
  } catch (error) {
    return handleRouteError(error, 'POST /api/research');
  }
}
