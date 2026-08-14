import {
  blockDomain,
  deleteCompaniesByDomain,
  listBlockedDomains,
  suppress,
  unblockDomain,
} from '@ejc/database';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { handleRouteError, readJsonBody } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const domainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+$/i, 'Not a valid hostname')
  .transform((value) => value.toLowerCase().replace(/^www\./, ''));

export async function GET() {
  try {
    return NextResponse.json({ domains: await listBlockedDomains() });
  } catch (error) {
    return handleRouteError(error, 'GET /api/admin/domains');
  }
}

const blockSchema = z.object({
  domain: domainSchema,
  reason: z.string().max(500).optional(),
  /** Also delete anything already indexed for the domain (GDPR erasure). */
  purge: z.boolean().default(false),
});

/**
 * Blocks a domain (plan section 40).
 *
 * Blocking writes to the suppression list as well as the blocklist, so a later
 * discovery run cannot quietly re-add what an operator removed.
 */
export async function POST(request: Request) {
  try {
    const body = blockSchema.parse(await readJsonBody(request));

    await blockDomain(body.domain, body.reason, 'admin');
    await suppress('domain', body.domain, body.reason);

    const removed = body.purge ? await deleteCompaniesByDomain(body.domain) : 0;

    return NextResponse.json({ ok: true, domain: body.domain, removedCompanies: removed });
  } catch (error) {
    return handleRouteError(error, 'POST /api/admin/domains');
  }
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const domain = domainSchema.parse(url.searchParams.get('domain') ?? '');
    await unblockDomain(domain);
    return NextResponse.json({ ok: true, domain });
  } catch (error) {
    return handleRouteError(error, 'DELETE /api/admin/domains');
  }
}
