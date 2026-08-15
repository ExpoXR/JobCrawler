import { crawlSite, type CrawlSiteResult } from '@ejc/crawler';
import { getLogger } from '@ejc/shared';

import type {
  DiscoveredJob,
  JobProvider,
  JobSearchQuery,
  ProviderContext,
  ProviderInfo,
} from '../types';

/**
 * Job discovery by crawling a company's own career pages (plan section 12).
 *
 * This is the provider that makes the whole product work: the employer's own
 * site is the authoritative source, it is legally the safest to read, and it
 * carries vacancies that never reach the job boards.
 */
export class CareerPageProvider implements JobProvider {
  readonly info: ProviderInfo = {
    key: 'career-page',
    name: 'Company career pages',
    capabilities: ['direct-crawling', 'structured-jobs', 'metadata-extraction'],
  };

  isAvailable(): boolean {
    return true;
  }

  async searchJobs(
    query: JobSearchQuery,
    context: ProviderContext = {},
  ): Promise<DiscoveredJob[]> {
    const company = query.company;
    const website = company?.website ?? (company?.domain ? `https://${company.domain}` : undefined);
    if (!website) return [];

    let result: CrawlSiteResult;
    try {
      result = await crawlSite(website, {
        ...(context.signal ? { signal: context.signal } : {}),
        ...(company?.id ? { companyId: company.id } : {}),
      });
    } catch (error) {
      getLogger('providers').debug('Career page crawl failed', {
        provider: this.info.key,
        company: company?.name,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const jobs: DiscoveredJob[] = [];
    const limit = query.limit ?? 50;

    for (const page of result.pages) {
      for (const extracted of page.jobs) {
        if (jobs.length >= limit) break;

        const job: DiscoveredJob = {
          title: extracted.title,
          applicationUrl: extracted.applicationUrl ?? page.url,
          provider: this.info.key,
          raw: { extraction: extracted.extraction, confidence: extracted.confidence },
        };

        if (extracted.description) job.description = extracted.description;
        if (extracted.companyName ?? company?.name) {
          job.companyName = extracted.companyName ?? company?.name;
        }
        if (extracted.city ?? company?.city) job.city = extracted.city ?? company?.city;
        if (extracted.country ?? company?.country) {
          job.country = extracted.country ?? company?.country;
        }
        if (extracted.countryCode ?? company?.countryCode) {
          job.countryCode = extracted.countryCode ?? company?.countryCode;
        }
        if (extracted.coordinates ?? company?.location) {
          job.location = extracted.coordinates ?? company?.location;
        }
        if (extracted.skills.length > 0) job.skills = extracted.skills;
        if (extracted.publishedAt) job.publishedAt = extracted.publishedAt;

        jobs.push(job);
      }
    }

    return jobs;
  }

  /** Exposes the full crawl so callers can also persist company-level findings. */
  async crawlCompanySite(
    website: string,
    context: ProviderContext = {},
  ): Promise<CrawlSiteResult> {
    return crawlSite(website, context.signal ? { signal: context.signal } : {});
  }
}

export const careerPageProvider = new CareerPageProvider();
