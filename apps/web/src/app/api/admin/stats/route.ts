import {
  checkDatabaseHealth,
  countCandidates,
  countCompanies,
  countJobs,
  getSearchStats,
  listRecentCrawlJobs,
} from '@ejc/database';
import { checkRedisHealth, getQueueStats } from '@ejc/queue';
import { NextResponse } from 'next/server';

import {
  clientKey,
  handleRouteError,
  rateLimit,
  tooManyRequests,
} from '@/lib/api';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Aggregated dashboard data (plan section 33). */
export async function GET(request: Request) {
  try {
    const limit = await rateLimit(clientKey(request, 'admin'), 60, 60_000);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
    await requireAdmin();

    const [database, redis, companies, jobs, candidates, searches, crawls] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      countCompanies(),
      countJobs(true),
      countCandidates(),
      getSearchStats(),
      listRecentCrawlJobs(20),
    ]);

    // Queue stats need Redis; report the rest even when it is down.
    const queues = redis.ok ? await getQueueStats().catch(() => []) : [];

    return NextResponse.json({
      health: { database, redis },
      counts: { companies, activeJobs: jobs, candidates },
      searches,
      queues,
      recentCrawls: crawls,
    });
  } catch (error) {
    return handleRouteError(error, 'GET /api/admin/stats');
  }
}
