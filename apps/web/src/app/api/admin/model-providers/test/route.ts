import { embedText, getAiProvider, resolveAiSettings, resolveEmbeddingSettings } from '@ejc/ai';
import { publicErrorMessage } from '@ejc/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  assertSameOrigin,
  clientKey,
  handleRouteError,
  rateLimit,
  readJsonBody,
  tooManyRequests,
} from '@/lib/api';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const testSchema = z.object({ kind: z.enum(['ai', 'embedding']).default('ai') });

/**
 * Confirms that whatever is configured actually answers.
 *
 * Tests the *stored* configuration rather than a payload, so an administrator
 * cannot use this endpoint to make the server call an arbitrary address with an
 * arbitrary credential.
 *
 * The failure message is deliberately narrow: `publicErrorMessage` for a
 * classified error, and a generic string otherwise. A provider's raw response
 * body can echo the API key back in an error, so it is never forwarded.
 */
export async function POST(request: Request) {
  try {
    // A real network call to a paid endpoint: the tightest budget in the app.
    const limit = await rateLimit(clientKey(request, 'provider-test'), 3, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    assertSameOrigin(request);
    await requireAdmin();

    const { kind } = testSchema.parse(await readJsonBody(request));
    const started = Date.now();

    if (kind === 'embedding') {
      const settings = await resolveEmbeddingSettings();
      const vector = await embedText('connection test');
      return NextResponse.json({
        ok: vector !== undefined,
        provider: settings.provider,
        model: settings.model,
        source: settings.source,
        dimensions: vector?.length ?? 0,
        durationMs: Date.now() - started,
        ...(vector === undefined
          ? { error: 'The provider returned no vector. Check the model name and endpoint.' }
          : {}),
      });
    }

    const settings = await resolveAiSettings();
    const provider = await getAiProvider();

    if (!provider.configured) {
      return NextResponse.json({
        ok: false,
        provider: settings.provider,
        source: settings.source,
        error:
          settings.provider === 'none'
            ? 'No AI provider is configured.'
            : 'This provider is missing its API key or endpoint.',
      });
    }

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxTokens: 5,
      temperature: 0,
    });

    return NextResponse.json({
      ok: result.text.trim().length > 0,
      provider: provider.key,
      model: result.model,
      source: settings.source,
      durationMs: Date.now() - started,
      reply: result.text.trim().slice(0, 100),
    });
  } catch (error) {
    // A failed test is a normal outcome, not a server fault: report it as data
    // so the dashboard can show it inline.
    if (error instanceof z.ZodError) return handleRouteError(error, 'POST provider test');
    return NextResponse.json({ ok: false, error: publicErrorMessage(error) });
  }
}
