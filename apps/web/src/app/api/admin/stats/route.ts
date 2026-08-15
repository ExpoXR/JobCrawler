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

import { handleRouteError } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Aggregated dashboard data (plan section 33). */
export async function GET() {
  try {
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
