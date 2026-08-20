import { getCompanyById, getSettingOr, listSearchResults } from '@ejc/database';
import { enqueue } from '@ejc/queue';
import { AppError, getConfig } from '@ejc/shared';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  assertSameOrigin,
  clientKey,
  handleRouteError,
  rateLimit,
  tooManyRequests,
} from '@/lib/api';
import { assertSearchAccess, requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.uuid() });

/**
 * Crawls the websites behind a search's current results.
 *
 * The second way in, next to the checkbox on the search form: having seen the
 * results, ask for the sites behind them to be read properly. Same queue, same
 * politeness rules, same per-domain budgets.
 *
 * Deliberately **not** open to anonymous callers. Everything else in the public
 * app is read-only; this one spends the deployment's outbound bandwidth and
 * shows up in third-party access logs under its own user agent, so it needs an
 * account behind it.
 */

/** An ordinary account may spend less of the deployment's goodwill than an admin. */
const DOMAIN_CAP: Record<'admin' | 'user', number> = { admin: 50, user: 10 };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    // A crawl is the most expensive thing a request can start.
    const limit = await rateLimit(clientKey(request, 'search-crawl'), 2, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    assertSameOrigin(request);
    const user = await requireUser();

    const { id } = paramsSchema.parse(await context.params);
    await assertSearchAccess(id);

    if (!(await getSettingOr('crawler.enabled', true))) {
      throw new AppError('not_configured', 'Live crawling is disabled on this deployment');
    }

    const config = getConfig();
    const cap = Math.min(DOMAIN_CAP[user.role], config.crawler.maxDomainsPerSearch);

    const results = await listSearchResults(id, { limit: 500 });

    /*
     * One job per domain, not per result: twenty vacancies at one employer are
     * one website. Deduplicating here is what keeps a large result set from
     * turning into a burst of requests at the same host.
     */
    const companyIds = new Set<string>();
    for (const item of results) {
      // A job result carries only `companyId`; a potential-employer result
      // carries the company itself.
      const id = item.company?.id ?? item.job?.companyId;
      if (id) companyIds.add(id);
      if (companyIds.size >= cap) break;
    }

    const byCompany = new Map<string, { companyId: string; website: string }>();
    for (const companyId of companyIds) {
      const company = await getCompanyById(companyId);
      if (!company) continue;

      const website = company.website ?? (company.domain ? `https://${company.domain}` : undefined);
      if (!website) continue;

      byCompany.set(company.id, { companyId: company.id, website });
    }

    if (byCompany.size === 0) {
      return NextResponse.json({
        queued: 0,
        message: 'None of these results has a known website to crawl.',
      });
    }

    let queued = 0;
    for (const entry of byCompany.values()) {
      // A stable job id per search+company collapses repeated clicks into one
      // job rather than queueing the same crawl twice.
      await enqueue('website-crawl', { searchId: id, ...entry }, { jobId: `crawl:${id}:${entry.companyId}` });
      queued += 1;
    }

    return NextResponse.json({
      queued,
      cap,
      message: `Crawling ${queued} website${queued === 1 ? '' : 's'}. Results appear as they are found.`,
    });
  } catch (error) {
    return handleRouteError(error, 'POST /api/search/[id]/crawl');
  }
}
