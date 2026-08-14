import { getCompanyById } from '@ejc/database';
import { enqueue } from '@ejc/queue';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError, jsonError, readJsonBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const requestSchema = z.union([
  z.object({ action: z.literal('company'), companyId: z.uuid() }),
  z.object({
    action: z.literal('maintenance'),
    task: z.enum(['expired-caches', 'expired-searches', 'stale-jobs']),
  }),
]);

/** Manual crawl / re-crawl / maintenance triggers (plan section 33). */
export async function POST(request: Request) {
  try {
    const body = requestSchema.parse(await readJsonBody(request));

    if (body.action === 'maintenance') {
      await enqueue('cleanup', { task: body.task });
      return NextResponse.json({ ok: true, queued: body.task });
    }

    const company = await getCompanyById(body.companyId);
    if (!company) return jsonError(404, 'Company not found');

    const website = company.website ?? (company.domain ? `https://${company.domain}` : undefined);
    if (!website) return jsonError(400, 'Company has no known website');

    await enqueue(
      'website-crawl',
      { companyId: company.id, website },
      { jobId: `recrawl:${company.id}:${Date.now()}` },
    );

    return NextResponse.json({ ok: true, queued: company.id });
  } catch (error) {
    return handleRouteError(error, 'POST /api/admin/recrawl');
  }
}
