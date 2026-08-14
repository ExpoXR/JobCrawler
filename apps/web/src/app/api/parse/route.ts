import { parseJobDescription, parseNaturalLanguageQuery } from '@ejc/ai';
import { naturalLanguageQuerySchema } from '@ejc/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { clientKey, handleRouteError, rateLimit, readJsonBody, tooManyRequests } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const requestSchema = naturalLanguageQuerySchema.extend({
  /** `description` treats the text as a pasted job ad (plan section 5.2). */
  kind: z.enum(['query', 'description']).default('query'),
});

/**
 * Turns free text into structured filters (plan section 6).
 *
 * The response is the parsed filter set, which the UI shows and lets the user
 * edit before searching — the parse is never applied invisibly.
 */
export async function POST(request: Request) {
  try {
    const limit = rateLimit(clientKey(request, 'parse'), 20, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const body = requestSchema.parse(await readJsonBody(request));

    const result =
      body.kind === 'description'
        ? await parseJobDescription(body.text)
        : await parseNaturalLanguageQuery(body.text);

    return NextResponse.json({ parsed: result.parsed, usedAi: result.usedAi });
  } catch (error) {
    return handleRouteError(error, 'POST /api/parse');
  }
}
