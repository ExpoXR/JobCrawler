import {
  canonicalizeSkills,
  classifyUrlPath,
  detectEmploymentType,
  detectSeniority,
  detectWorkModel,
  type EmploymentType,
  employmentTypeFromSchemaOrg,
  extractExperienceYears,
  extractLanguages,
  extractSkills,
  type GeoPoint,
  jsonLdJobPostingSchema,
  sanitizeScrapedText,
  type Seniority,
  type WorkModel,
} from '@ejc/shared';

import type { ExtractedPage } from './extract';

/**
 * JobPosting extraction (plan section 12).
 *
 * Two paths, in order of trust:
 *   1. schema.org JSON-LD — structured, validated, and by far the most reliable
 *   2. heuristic HTML reading — for the many sites that publish no structured data
 *
 * Nothing extracted here is trusted as-is: the JSON-LD is validated with Zod
 * and every string is sanitised before it can reach the database.
 */

export interface ExtractedJob {
  title: string;
  description?: string;
  companyName?: string;
  companyUrl?: string;
  locationText?: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  coordinates?: GeoPoint;
  workModel: WorkModel;
  employmentType: EmploymentType;
  seniority: Seniority;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: 'hour' | 'day' | 'month' | 'year';
  requiredExperienceYears?: number;
  languages: string[];
  skills: string[];
  publishedAt?: string;
  expiresAt?: string;
  applicationUrl?: string;
  /** How the posting was recognised. */
  extraction: 'json-ld' | 'heuristic';
  confidence: number;
}

function typeIncludes(value: unknown, wanted: string): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(wanted);
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes(wanted));
  }
  return false;
}

/** Walks a JSON-LD document (including @graph) collecting JobPosting nodes. */
export function collectJobPostingNodes(block: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || block === null || typeof block !== 'object') return [];

  if (Array.isArray(block)) {
    return block.flatMap((entry) => collectJobPostingNodes(entry, depth + 1));
  }

  const node = block as Record<string, unknown>;
  const found: Record<string, unknown>[] = [];

  if (typeIncludes(node['@type'], 'jobposting')) found.push(node);

  for (const key of ['@graph', 'itemListElement', 'mainEntity', 'item']) {
    if (key in node) found.push(...collectJobPostingNodes(node[key], depth + 1));
  }

  return found;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // Reject nonsense dates that would poison sorting.
  const year = parsed.getUTCFullYear();
  if (year < 1990 || year > 2100) return undefined;
  return parsed.toISOString();
}

interface AddressParts {
  locationText?: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  coordinates?: GeoPoint;
}

function parseJobLocation(value: unknown, depth = 0): AddressParts {
  if (depth > 4 || !value || typeof value !== 'object') return {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseJobLocation(entry, depth + 1);
      if (parsed.city ?? parsed.locationText) return parsed;
    }
    return {};
  }

  const node = value as Record<string, unknown>;
  const address = node['address'];
  const geo = node['geo'] as Record<string, unknown> | undefined;

  const parts: AddressParts = {};

  if (typeof address === 'string') {
    parts.locationText = sanitizeScrapedText(address, 200);
  } else if (address && typeof address === 'object') {
    const addressNode = address as Record<string, unknown>;
    const locality = addressNode['addressLocality'];
    const region = addressNode['addressRegion'];
    const country = addressNode['addressCountry'];
    const street = addressNode['streetAddress'];

    if (typeof locality === 'string') parts.city = sanitizeScrapedText(locality, 120);
    if (typeof region === 'string') parts.region = sanitizeScrapedText(region, 120);
    if (typeof country === 'string') {
      const value = sanitizeScrapedText(country, 60);
      parts.country = value;
      if (/^[A-Za-z]{2}$/.test(value)) parts.countryCode = value.toUpperCase();
    } else if (country && typeof country === 'object') {
      const name = (country as Record<string, unknown>)['name'];
      if (typeof name === 'string') parts.country = sanitizeScrapedText(name, 60);
    }

    parts.locationText = [street, locality, region, parts.country]
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .join(', ')
      .slice(0, 200);
  }

  if (geo) {
    const lat = Number(geo['latitude']);
    const lon = Number(geo['longitude']);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      parts.coordinates = { lat, lon };
    }
  }

  if (!parts.locationText && !parts.city) {
    const name = node['name'];
    if (typeof name === 'string') parts.locationText = sanitizeScrapedText(name, 200);
  }

  return parts;
}

interface SalaryParts {
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: 'hour' | 'day' | 'month' | 'year';
}

function parseSalary(value: unknown): SalaryParts {
  if (!value || typeof value !== 'object') return {};
  const node = value as Record<string, unknown>;

  const currency = node['currency'] ?? node['salaryCurrency'];
  const parts: SalaryParts = {};
  if (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency)) {
    parts.salaryCurrency = currency.toUpperCase();
  }

  const spec = node['value'];
  if (spec && typeof spec === 'object') {
    const specNode = spec as Record<string, unknown>;
    const min = Number(specNode['minValue'] ?? specNode['value']);
    const max = Number(specNode['maxValue'] ?? specNode['value']);
    if (Number.isFinite(min) && min > 0) parts.salaryMin = min;
    if (Number.isFinite(max) && max > 0) parts.salaryMax = max;

    const unit = specNode['unitText'];
    if (typeof unit === 'string') {
      const normalized = unit.toUpperCase();
      if (normalized === 'HOUR') parts.salaryPeriod = 'hour';
      else if (normalized === 'DAY') parts.salaryPeriod = 'day';
      else if (normalized === 'MONTH') parts.salaryPeriod = 'month';
      else if (normalized === 'YEAR') parts.salaryPeriod = 'year';
    }
  }

  if (parts.salaryMin && parts.salaryMax && parts.salaryMin > parts.salaryMax) {
    const swap = parts.salaryMin;
    parts.salaryMin = parts.salaryMax;
    parts.salaryMax = swap;
  }

  return parts;
}

function toStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,;\n•]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 1 && entry.length < 80);
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

/** Converts one validated JSON-LD JobPosting node into our shape. */
export function jobFromJsonLd(node: Record<string, unknown>): ExtractedJob | undefined {
  const parsed = jsonLdJobPostingSchema.safeParse(node);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  const title = data.title ? sanitizeScrapedText(data.title, 300) : '';
  if (!title) return undefined;

  const description = data.description
    ? sanitizeScrapedText(stripHtml(data.description), 20_000)
    : undefined;

  const location = parseJobLocation(data.jobLocation);
  const salary = parseSalary(data.baseSalary);

  const employmentType = data.employmentType
    ? employmentTypeFromSchemaOrg(
        Array.isArray(data.employmentType)
          ? (data.employmentType[0] ?? '')
          : data.employmentType,
      )
    : detectEmploymentType(`${title} ${description ?? ''}`);

  const remoteHint = `${data.jobLocationType ?? ''} ${title} ${description ?? ''}`;
  const workModel = data.jobLocationType?.toUpperCase().includes('TELECOMMUTE')
    ? 'remote'
    : detectWorkModel(remoteHint);

  const searchText = `${title} ${description ?? ''}`;
  const skills = canonicalizeSkills([
    ...toStringList(data.skills),
    ...toStringList(data.qualifications),
    ...extractSkills(searchText),
  ]);

  const job: ExtractedJob = {
    title,
    workModel,
    employmentType,
    seniority: detectSeniority(title) === 'unknown' ? detectSeniority(searchText) : detectSeniority(title),
    languages: extractLanguages(searchText),
    skills,
    extraction: 'json-ld',
    confidence: 0.9,
  };

  if (description) job.description = description;

  const hiring = data.hiringOrganization;
  if (typeof hiring === 'string') {
    job.companyName = sanitizeScrapedText(hiring, 200);
  } else if (hiring && typeof hiring === 'object') {
    if (hiring.name) job.companyName = sanitizeScrapedText(hiring.name, 200);
    const url = hiring.url ?? hiring.sameAs;
    if (url) job.companyUrl = url;
  }

  if (location.locationText) job.locationText = location.locationText;
  if (location.city) job.city = location.city;
  if (location.region) job.region = location.region;
  if (location.country) job.country = location.country;
  if (location.countryCode) job.countryCode = location.countryCode;
  if (location.coordinates) job.coordinates = location.coordinates;

  if (salary.salaryMin !== undefined) job.salaryMin = salary.salaryMin;
  if (salary.salaryMax !== undefined) job.salaryMax = salary.salaryMax;
  if (salary.salaryCurrency) job.salaryCurrency = salary.salaryCurrency;
  if (salary.salaryPeriod) job.salaryPeriod = salary.salaryPeriod;

  const experience = extractExperienceYears(searchText);
  if (experience !== undefined) job.requiredExperienceYears = experience;

  const published = normalizeDate(data.datePosted);
  if (published) job.publishedAt = published;
  const expires = normalizeDate(data.validThrough);
  if (expires) job.expiresAt = expires;
  if (data.url) job.applicationUrl = data.url;

  return job;
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

/** Extracts every JobPosting present in a page's structured data. */
export function extractJobsFromJsonLd(page: ExtractedPage): ExtractedJob[] {
  const jobs: ExtractedJob[] = [];
  for (const block of page.jsonLdBlocks) {
    for (const node of collectJobPostingNodes(block)) {
      const job = jobFromJsonLd(node);
      if (job) jobs.push(job);
    }
  }
  return jobs;
}

const JOB_PAGE_SIGNALS = [
  'ihre aufgaben',
  'deine aufgaben',
  'dein profil',
  'ihr profil',
  'wir bieten',
  'what you will do',
  'your responsibilities',
  'your profile',
  'we offer',
  'requirements',
  'qualifications',
  'apply now',
  'jetzt bewerben',
  'bewerbung',
];

/**
 * Heuristic extraction for pages without JSON-LD.
 *
 * Requires several independent signals before it will claim a page is a job
 * posting — a careers *index* page must not become a phantom vacancy.
 */
export function extractJobFromHtml(page: ExtractedPage, url: string): ExtractedJob | undefined {
  const heading = page.headings[0] ?? page.title;
  if (!heading) return undefined;

  const haystack = `${page.title ?? ''} ${page.headings.join(' ')} ${page.text}`.toLowerCase();
  const signalCount = JOB_PAGE_SIGNALS.filter((signal) => haystack.includes(signal)).length;
  const { category } = classifyUrlPath(url);

  // A single generic signal on an index page is not enough.
  const isLikelyPosting = category === 'job' ? signalCount >= 1 : signalCount >= 3;
  if (!isLikelyPosting) return undefined;

  const title = sanitizeScrapedText(heading, 300);
  if (title.length < 3) return undefined;

  const description = sanitizeScrapedText(page.text, 20_000);
  const searchText = `${title} ${description}`;

  const job: ExtractedJob = {
    title,
    description,
    workModel: detectWorkModel(searchText),
    employmentType: detectEmploymentType(searchText),
    seniority: detectSeniority(title),
    languages: extractLanguages(searchText),
    skills: canonicalizeSkills([...page.skills, ...extractSkills(searchText)]),
    applicationUrl: url,
    extraction: 'heuristic',
    confidence: Math.min(0.75, 0.35 + signalCount * 0.1),
  };

  const experience = extractExperienceYears(searchText);
  if (experience !== undefined) job.requiredExperienceYears = experience;

  return job;
}
