import { getSearchProgress } from '@ejc/database';
import { z } from 'zod';

import {
  clientKey,
  handleRouteError,
  jsonError,
  rateLimit,
  tooManyRequests,
} from '@/lib/api';
import { assertSearchAccess } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.uuid() });

/**
 * Server-Sent Events progress stream (plan section 25).
 *
 * SSE over WebSockets: the traffic is one-directional, it survives proxies and
 * reconnects on its own, and it needs no extra server. The stream polls the
 * search row — the source of truth that workers already update — rather than
 * introducing a pub/sub channel the MVP does not need.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    // Each stream holds a connection for up to ten minutes, so opening them is
    // the cheap half of a resource-exhaustion attack. This caps how many a
    // single client can start, not how long one may run.
    const limit = await rateLimit(clientKey(request, 'sse'), 20, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const { id } = paramsSchema.parse(await context.params);

    await assertSearchAccess(id);

    const initial = await getSearchProgress(id);
    if (!initial) return jsonError(404, 'Search not found');

    const encoder = new TextEncoder();
    const POLL_MS = 1500;
    const MAX_DURATION_MS = 10 * 60 * 1000;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const started = Date.now();
        let lastPayload = '';
        let closed = false;

        const send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        };

        send('progress', initial);
        lastPayload = JSON.stringify(initial);

        const finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          try {
            controller.close();
          } catch {
            // The client may already be gone; nothing to do.
          }
        };

        const timer = setInterval(() => {
          void (async () => {
            if (closed) return;
            try {
              const progress = await getSearchProgress(id);
              if (!progress) return finish();

              const payload = JSON.stringify(progress);
              if (payload !== lastPayload) {
                lastPayload = payload;
                send('progress', progress);
              } else {
                // Comment frames keep intermediary proxies from timing out.
                controller.enqueue(encoder.encode(': keep-alive\n\n'));
              }

              if (
                progress.stage === 'completed' ||
                progress.stage === 'failed' ||
                Date.now() - started > MAX_DURATION_MS
              ) {
                send('done', progress);
                finish();
              }
            } catch {
              finish();
            }
          })();
        }, POLL_MS);
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return handleRouteError(error, 'GET /api/search/[id]/events');
  }
}
