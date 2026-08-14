#!/usr/bin/env tsx
/**
 * Development seed data.
 *
 * Creates a handful of companies and vacancies around Kempten — the plan's
 * reference scenario (section 42) — so the UI, the matcher and the export path
 * can be exercised without waiting for a live crawl.
 *
 *   npm run seed
 */
import { upsertCompany } from '../repositories/companies';
import { upsertJob } from '../repositories/jobs';
import { closePool } from '../pool';

interface SeedCompany {
  name: string;
  domain: string;
  city: string;
  location: { lat: number; lon: number };
  industry: string;
  technologies: string[];
  jobs: Array<{
    title: string;
    description: string;
    skills: string[];
    workModel: 'remote' | 'hybrid' | 'onsite';
    seniority: 'junior' | 'mid' | 'senior' | 'lead';
    salaryMin?: number;
    salaryMax?: number;
  }>;
}

const SEED: SeedCompany[] = [
  {
    name: 'Allgäu Web Studio GmbH',
    domain: 'allgaeu-web-studio.example',
    city: 'Kempten',
    location: { lat: 47.7267, lon: 10.3168 },
    industry: 'Digital Agency',
    technologies: ['react', 'next.js', 'typescript', 'wordpress'],
    jobs: [
      {
        title: 'Frontend Developer React / Next.js (m/w/d)',
        description:
          'Du entwickelst moderne Weboberflächen mit React, Next.js und TypeScript. ' +
          'Wir arbeiten hybrid und legen Wert auf sauberen Code. Mindestens 3 Jahre Erfahrung.',
        skills: ['react', 'next.js', 'typescript'],
        workModel: 'hybrid',
        seniority: 'mid',
        salaryMin: 55_000,
        salaryMax: 70_000,
      },
    ],
  },
  {
    name: 'Bodensee Software AG',
    domain: 'bodensee-software.example',
    city: 'Lindau',
    location: { lat: 47.5461, lon: 9.6845 },
    industry: 'Software',
    technologies: ['java', 'spring', 'postgresql', 'kubernetes'],
    jobs: [
      {
        title: 'Senior Backend Engineer (m/w/d)',
        description:
          'Java und Spring Boot im Kubernetes-Umfeld. Erfahrung mit PostgreSQL erforderlich.',
        skills: ['java', 'spring', 'postgresql', 'kubernetes'],
        workModel: 'onsite',
        seniority: 'senior',
        salaryMin: 70_000,
        salaryMax: 90_000,
      },
    ],
  },
  {
    name: 'Memminger Digitalwerk',
    domain: 'memminger-digitalwerk.example',
    city: 'Memmingen',
    location: { lat: 47.9878, lon: 10.1811 },
    industry: 'Digital Agency',
    technologies: ['react', 'typescript', 'shopware', 'php'],
    // No vacancies: this is the "potential employer" case (plan section 18).
    jobs: [],
  },
  {
    name: 'München Cloud Systems GmbH',
    domain: 'muenchen-cloud.example',
    city: 'München',
    location: { lat: 48.1372, lon: 11.5756 },
    industry: 'Cloud Infrastructure',
    technologies: ['go', 'kubernetes', 'terraform', 'aws'],
    jobs: [
      {
        title: 'Platform Engineer (m/w/d)',
        description: 'Go, Kubernetes und Terraform auf AWS. Remote möglich.',
        skills: ['go', 'kubernetes', 'terraform', 'aws'],
        workModel: 'remote',
        seniority: 'senior',
      },
    ],
  },
];

async function main(): Promise<void> {
  let companyCount = 0;
  let jobCount = 0;

  for (const entry of SEED) {
    const company = await upsertCompany({
      name: entry.name,
      domain: entry.domain,
      website: `https://${entry.domain}`,
      city: entry.city,
      country: 'Germany',
      countryCode: 'DE',
      location: entry.location,
      industry: entry.industry,
      technologies: entry.technologies,
      careerPageUrl: `https://${entry.domain}/karriere`,
    });
    companyCount += 1;

    for (const job of entry.jobs) {
      const url = `https://${entry.domain}/karriere/${job.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`;

      await upsertJob({
        companyId: company.id,
        companyName: company.name,
        title: job.title,
        description: job.description,
        city: entry.city,
        country: 'Germany',
        countryCode: 'DE',
        coordinates: entry.location,
        workModel: job.workModel,
        employmentType: 'full_time',
        seniority: job.seniority,
        ...(job.salaryMin !== undefined ? { salaryMin: job.salaryMin } : {}),
        ...(job.salaryMax !== undefined ? { salaryMax: job.salaryMax } : {}),
        salaryCurrency: 'EUR',
        skills: job.skills,
        applicationUrl: url,
        canonicalUrl: url,
        publishedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        source: { provider: 'seed', url, isPrimary: true },
      });
      jobCount += 1;
    }
  }

  console.log(`Seeded ${companyCount} companies and ${jobCount} jobs.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
