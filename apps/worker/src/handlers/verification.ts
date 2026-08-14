import { verifyJobUrl } from '@ejc/crawler';
import {
  findCompaniesDueForRecrawl,
  findJobsDueForVerification,
  getCompanyById,
  markCompanyVerified,
  markJobInactive,
  markJobVerified,
  refreshActiveJobCount,
} from '@ejc/database';
import { createWorker, enqueue, type WorkerHandle } from '@ejc/queue';
import { crawlCompanyForJobs } from '@ejc/search';
import { getConfig, getLogger } from '@ejc/shared';

/**
 * Verification workers (plan section 32).
 *
 * The important rule: a vacancy is only marked inactive on a *conclusive*
 * negative — a 404/410 or a page that no longer contains a posting. Timeouts,
 * 429s and 5xx leave the job alone, because a flaky origin must not silently
 * empty the index.
 */

const logger = getLogger('worker');

export function registerVerificationWorkers(): WorkerHandle[] {
  const verification = createWorker('verification', async (job) => {
    const { kind, id } = job.data;

    if (kind === 'job') {
      const target = await import('@ejc/database').then((db) => db.getJobById(id));
      if (!target) return;

      const url = target.applicationUrl ?? target.sources[0]?.url;
      if (!url) return;

      const outcome = await verifyJobUrl(url);
      if (!outcome.conclusive) {
        logger.debug('Job verification inconclusive; leaving state unchanged', { jobId: id });
        return;
      }

      if (outcome.stillPresent) await markJobVerified(id);
      else await markJobInactive(id);

      if (target.companyId) await refreshActiveJobCount(target.companyId);
      return;
    }

    if (kind === 'company') {
      const company = await getCompanyById(id);
      if (!company) return;
      await crawlCompanyForJobs(undefined, company, undefined);
      await markCompanyVerified(id);
    }
  });

  return [verification];
}

/**
 * Enqueues everything that is due for re-verification.
 *
 * Called from the cleanup queue on a schedule rather than by a cron process, so
 * the whole system needs only Redis and Postgres to run.
 */
export async function enqueueDueVerifications(): Promise<{ jobs: number; companies: number }> {
  const config = getConfig();

  const dueJobs = await findJobsDueForVerification(config.retention.recrawlJobHours, 200);
  for (const job of dueJobs) {
    await enqueue('verification', { kind: 'job', id: job.id }, { jobId: `verify:job:${job.id}` });
  }

  const dueCompanies = await findCompaniesDueForRecrawl(config.retention.recrawlCompanyDays, 50);
  for (const company of dueCompanies) {
    await enqueue(
      'verification',
      { kind: 'company', id: company.id },
      { jobId: `verify:company:${company.id}` },
    );
  }

  logger.info('Queued due verifications', {
    jobs: dueJobs.length,
    companies: dueCompanies.length,
  });

  return { jobs: dueJobs.length, companies: dueCompanies.length };
}
