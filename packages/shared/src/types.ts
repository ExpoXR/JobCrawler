/**
 * Domain types shared by every package.
 *
 * These mirror the data model described in plan sections 14–16 and the search
 * contracts in sections 5–7. Runtime validation lives in `schemas.ts`; this
 * file is the compile-time surface.
 */

export type SearchMode = 'jobs' | 'candidates';

export type WorkModel = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export type EmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contract'
  | 'freelance'
  | 'internship'
  | 'temporary'
  | 'apprenticeship'
  | 'unknown';

export type Seniority =
  | 'intern'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'lead'
  | 'principal'
  | 'executive'
  | 'unknown';

/** How much we trust a field — surfaced in the UI (plan section 29). */
export type Confidence = 'confirmed' | 'inferred' | 'uncertain';

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface GeoLocation extends GeoPoint {
  label: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  postalCode?: string;
  /** Provider that produced this location, for provenance. */
  source?: string;
}

export interface SourceReference {
  url: string;
  provider: string;
  /** When the URL was last successfully fetched. */
  retrievedAt?: string;
  title?: string;
}

export interface Company {
  id: string;
  name: string;
  normalizedName: string;
  domain?: string;
  website?: string;
  description?: string;
  industry?: string;
  address?: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  location?: GeoPoint;
  technologies: string[];
  services: string[];
  sizeBucket?: string;
  employeeCountMin?: number;
  employeeCountMax?: number;
  socialLinks: Record<string, string>;
  careerPageUrl?: string;
  contactPageUrl?: string;
  publicEmail?: string;
  publicPhone?: string;
  sitemapUrls: string[];
  activeJobCount: number;
  sources: SourceReference[];
  aiSummary?: string;
  lastCrawledAt?: string;
  lastVerifiedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Job {
  id: string;
  companyId?: string;
  companyName?: string;
  title: string;
  normalizedTitle: string;
  location?: string;
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
  skills: string[];
  technologies: string[];
  requiredExperienceYears?: number;
  preferredExperienceYears?: number;
  languages: string[];
  description?: string;
  aiSummary?: string;
  applicationUrl?: string;
  sources: SourceReference[];
  publishedAt?: string;
  expiresAt?: string;
  discoveredAt?: string;
  lastVerifiedAt?: string;
  isActive: boolean;
}

/**
 * Deliberately minimal (plan section 16): public professional signal only,
 * never a mirrored profile.
 */
export interface Candidate {
  id: string;
  publicName?: string;
  publicTitle?: string;
  approximateLocation?: string;
  coordinates?: GeoPoint;
  countryCode?: string;
  skills: string[];
  technologies: string[];
  profileUrl: string;
  portfolioUrl?: string;
  githubUrl?: string;
  sources: SourceReference[];
  aiSummary?: string;
  discoveredAt?: string;
  lastCheckedAt?: string;
}

/** A user's structured search intent, parsed from the form or from free text. */
export interface SearchQuery {
  mode: SearchMode;
  locationText: string;
  location?: GeoLocation;
  radiusKm: number;
  role: string;
  requiredSkills: string[];
  preferredSkills: string[];
  technologies: string[];
  seniority?: Seniority;
  minExperienceYears?: number;
  employmentTypes: EmploymentType[];
  workModels: WorkModel[];
  industries: string[];
  languages: string[];
  companySizes: string[];
  salaryMin?: number;
  salaryCurrency?: string;
  keywords: string[];
  exclusions: string[];
  includePotentialEmployers: boolean;
  minMatchScore: number;
  /** Free-text query the parse came from, when applicable. */
  rawQuery?: string;
}

export type MatchEvidenceKind = 'match' | 'partial' | 'miss' | 'info';

export interface MatchEvidence {
  kind: MatchEvidenceKind;
  label: string;
  /** Named scoring component this evidence belongs to. */
  component: string;
  sourceUrl?: string;
  confidence?: Confidence;
}

export interface MatchComponentScore {
  component: string;
  /** Normalised 0..1 score for this component. */
  score: number;
  weight: number;
  detail?: string;
}

export interface MatchResult {
  /** Final 0..100 score. */
  score: number;
  rejected: boolean;
  rejectionReasons: string[];
  components: MatchComponentScore[];
  evidence: MatchEvidence[];
}

export type SearchResultKind = 'job' | 'potential_employer' | 'candidate';

export interface SearchResultItem {
  id: string;
  kind: SearchResultKind;
  match: MatchResult;
  distanceKm?: number;
  job?: Job;
  company?: Company;
  candidate?: Candidate;
}

export type SearchStage =
  | 'queued'
  | 'searching_database'
  | 'discovering_companies'
  | 'searching_job_sources'
  | 'checking_company_websites'
  | 'reading_sitemaps'
  | 'analyzing_career_pages'
  | 'extracting_jobs'
  | 'searching_profiles'
  | 'generating_embeddings'
  | 'calculating_matches'
  | 'researching_top_results'
  | 'completed'
  | 'failed';

export interface SearchProgress {
  searchId: string;
  stage: SearchStage;
  /** 0..100, monotonically non-decreasing. */
  percent: number;
  message: string;
  resultCount: number;
  updatedAt: string;
  errors: string[];
}
