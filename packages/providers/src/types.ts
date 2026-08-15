import type { Candidate, Company, GeoLocation, GeoPoint, Job, SearchQuery } from '@ejc/shared';

/**
 * Provider contracts (plan section 11).
 *
 * Every external source implements one of these. Providers advertise their
 * capabilities so the orchestrator can plan a search without knowing what any
 * particular provider is — adding a source never means editing the search code.
 */

export type ProviderCapability =
  | 'direct-crawling'
  | 'api-search'
  | 'metadata-extraction'
  | 'profile-discovery'
  | 'external-link-only'
  | 'geocoding'
  | 'reverse-geocoding'
  | 'radius-search'
  | 'structured-jobs';

export interface ProviderInfo {
  key: string;
  name: string;
  /** Documentation or terms-of-service URL — surfaced in the admin UI. */
  homepage?: string;
  capabilities: ProviderCapability[];
  /** Requests per minute this source tolerates. */
  rateLimitPerMinute?: number;
  /** True when the provider needs credentials that may not be present. */
  requiresCredentials?: boolean;
}

export interface ProviderContext {
  signal?: AbortSignal;
  /** Correlates provider work with the search that triggered it. */
  searchId?: string;
}

export interface BaseProvider {
  readonly info: ProviderInfo;
  /** False when required configuration is missing; the source is then skipped. */
  isAvailable(): boolean;
}

export interface GeocodingProvider extends BaseProvider {
  geocode(query: string, context?: ProviderContext): Promise<GeoLocation[]>;
  reverseGeocode?(point: GeoPoint, context?: ProviderContext): Promise<GeoLocation | undefined>;
}

export interface CompanySearchQuery {
  center: GeoPoint;
  radiusKm: number;
  /** Free-text role/industry hint used to bias the search. */
  keywords?: string[];
  limit?: number;
}

export interface DiscoveredCompany {
  name: string;
  website?: string;
  domain?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  location?: GeoPoint;
  industry?: string;
  publicEmail?: string;
  publicPhone?: string;
  /** Stable identifier at the source, e.g. `node/123456`. */
  sourceId?: string;
  sourceUrl?: string;
  provider: string;
}

export interface CompanyProvider extends BaseProvider {
  discoverCompanies(
    query: CompanySearchQuery,
    context?: ProviderContext,
  ): Promise<DiscoveredCompany[]>;
}

export interface JobSearchQuery {
  query: SearchQuery;
  /** Restrict to a single company when crawling its career page. */
  company?: Company;
  limit?: number;
}

export interface DiscoveredJob {
  title: string;
  description?: string;
  companyName?: string;
  applicationUrl: string;
  city?: string;
  country?: string;
  countryCode?: string;
  location?: GeoPoint;
  skills?: string[];
  publishedAt?: string;
  provider: string;
  /** Raw payload retained for provenance and debugging. */
  raw?: unknown;
}

export interface JobProvider extends BaseProvider {
  searchJobs(query: JobSearchQuery, context?: ProviderContext): Promise<DiscoveredJob[]>;
}

export interface CandidateSearchQuery {
  query: SearchQuery;
  limit?: number;
}

export interface DiscoveredCandidate {
  publicName?: string;
  publicTitle?: string;
  approximateLocation?: string;
  skills?: string[];
  technologies?: string[];
  profileUrl: string;
  portfolioUrl?: string;
  githubUrl?: string;
  provider: string;
}

export interface CandidateProvider extends BaseProvider {
  searchCandidates(
    query: CandidateSearchQuery,
    context?: ProviderContext,
  ): Promise<DiscoveredCandidate[]>;
}

export type AnyProvider =
  | GeocodingProvider
  | CompanyProvider
  | JobProvider
  | CandidateProvider;

export function hasCapability(provider: BaseProvider, capability: ProviderCapability): boolean {
  return provider.info.capabilities.includes(capability);
}

/** Narrowing helpers so the registry can stay typed without casts at call sites. */
export function isCompanyProvider(provider: AnyProvider): provider is CompanyProvider {
  return 'discoverCompanies' in provider;
}

export function isJobProvider(provider: AnyProvider): provider is JobProvider {
  return 'searchJobs' in provider;
}

export function isCandidateProvider(provider: AnyProvider): provider is CandidateProvider {
  return 'searchCandidates' in provider;
}

export function isGeocodingProvider(provider: AnyProvider): provider is GeocodingProvider {
  return 'geocode' in provider;
}

export type { Candidate, Company, Job };
