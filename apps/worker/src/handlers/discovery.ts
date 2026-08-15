import { getCompanyById } from '@ejc/database';
import { createWorker, enqueue, type WorkerHandle } from '@ejc/queue';
import {
  advanceStage,
  crawlCompanies,
  crawlCompanyForJobs,
  discoverCandidates,
  discoverCompanies,
} from '@ejc/search';
import { getConfig, getLogger } from '@ejc/shared';

/**
 * Discovery workers: the live half of the hybrid search (plan section 7).
 *
 * `company-discovery` owns the whole pipeline for a search so that progress
 * reporting has a single owner; `website-crawl` exists separately so that
 * individual re-crawls (admin actions, scheduled refreshes) can reuse the same
 * code path without going through a search.
 */

const logger = getLogger('worker');

export function registerDiscoveryWorkers(): WorkerHandle[] {
  const config = getConfig();

  const companyDiscovery = createWorker(
    'company-discovery',
    async (job) => {
      const { searchId, query } = job.data;

      const { companies, errors } = await discoverCompanies(searchId, query);
      for (const failed of errors) {
        await advanceStage(searchId, 'discovering_companies', {
          message: `Provider ${failed} unavailable; continuing`,
          error: `provider:${failed}`,
        });
      }

      if (companies.length === 0) {
        await advanceStage(searchId, 'completed', {
          message: 'No additional companies found in this area',
        });
        return;
      }

      await crawlCompanies(searchId, query, companies);
      await advanceStage(searchId, 'calculating_matches');
      await advanceStage(searchId, 'completed');
    },
    // One search at a time per worker: each fans out to many page fetches.
    { concurrency: Math.max(1, Math.floor(config.worker.concurrency / 2)) },
  );

  const websiteCrawl = createWorker('website-crawl', async (job) => {
    const { companyId, searchId, query } = job.data;
    const company = await getCompanyById(companyId);
    if (!company) {
      logger.warn('Crawl requested for unknown company', { companyId });
      return;
    }
    await crawlCompanyForJobs(searchId, company, query);
  });

  const jobDiscovery = createWorker('job-discovery', async (job) => {
    const { companyId, searchId, query } = job.data;
    const company = await getCompanyById(companyId);
    if (!company) return;
    await crawlCompanyForJobs(searchId, company, query);
  });

  const candidateDiscovery = createWorker('candidate-discovery', async (job) => {
    const { searchId, query } = job.data;
    const found = await discoverCandidates(searchId, query);
    await advanceStage(searchId, 'completed', {
      message: `Found ${found} public profiles`,
      resultCount: found,
    });
  });

  return [companyDiscovery, websiteCrawl, jobDiscovery, candidateDiscovery];
}

/** Queues a re-crawl for a single company (used by the admin dashboard). */
export async function requestCompanyRecrawl(companyId: string, website: string): Promise<void> {
  await enqueue('website-crawl', { companyId, website }, { jobId: `recrawl:${companyId}` });
}
