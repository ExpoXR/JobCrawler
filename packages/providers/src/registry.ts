import { getLogger } from '@ejc/shared';
import { getEnabledProviderKeys, registerSourceProvider } from '@ejc/database';

import { githubCandidateProvider } from './candidate/github';
import { overpassProvider } from './company/overpass';
import { nominatimProvider } from './geocoding/nominatim';
import { careerPageProvider } from './job/careerPage';
import type {
  AnyProvider,
  CandidateProvider,
  CompanyProvider,
  GeocodingProvider,
  JobProvider,
} from './types';

/**
 * Provider registry (plan section 11).
 *
 * Providers register themselves here and the search orchestrator asks the
 * registry for "all enabled company providers" rather than importing any
 * particular one. Enabling/disabling is an admin decision stored in the
 * database; code only supplies the default.
 */

export type RegistryKind = 'geocoding' | 'company' | 'job' | 'candidate';

interface RegistryEntry {
  provider: AnyProvider;
  kind: RegistryKind;
  enabledByDefault: boolean;
}

const entries = new Map<string, RegistryEntry>();

export function registerProvider(
  provider: AnyProvider,
  kind: RegistryKind,
  enabledByDefault = true,
): void {
  entries.set(provider.info.key, { provider, kind, enabledByDefault });
}

/** Built-in providers. Order here is the default preference order. */
registerProvider(nominatimProvider, 'geocoding');
registerProvider(overpassProvider, 'company');
registerProvider(careerPageProvider, 'job');
registerProvider(githubCandidateProvider, 'candidate');

export function listProviders(kind?: RegistryKind): RegistryEntry[] {
  const all = [...entries.values()];
  return kind ? all.filter((entry) => entry.kind === kind) : all;
}

export function getProvider(key: string): AnyProvider | undefined {
  return entries.get(key)?.provider;
}

/**
 * Mirrors the code-defined providers into `source_providers` so the admin UI
 * can list and toggle them. Idempotent — safe to call on every boot.
 */
export async function syncProviderRegistry(): Promise<void> {
  const logger = getLogger('providers');
  for (const entry of entries.values()) {
    try {
      await registerSourceProvider({
        key: entry.provider.info.key,
        name: entry.provider.info.name,
        kind: entry.kind,
        capabilities: entry.provider.info.capabilities,
        enabledByDefault: entry.enabledByDefault,
        ...(entry.provider.info.rateLimitPerMinute !== undefined
          ? { rateLimitPerMinute: entry.provider.info.rateLimitPerMinute }
          : {}),
      });
    } catch (error) {
      logger.warn('Failed to register provider', {
        provider: entry.provider.info.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Resolves the providers to use for a kind: registered, available (configured)
 * and not disabled by an admin. Falls back to defaults if the registry table
 * cannot be read, so a database hiccup does not disable discovery entirely.
 */
async function resolveEnabled(kind: RegistryKind): Promise<AnyProvider[]> {
  const candidates = listProviders(kind).filter((entry) => entry.provider.isAvailable());

  let enabledKeys: Set<string> | undefined;
  try {
    enabledKeys = await getEnabledProviderKeys(kind);
  } catch {
    enabledKeys = undefined;
  }

  return candidates
    .filter((entry) => {
      if (!enabledKeys || enabledKeys.size === 0) return entry.enabledByDefault;
      return enabledKeys.has(entry.provider.info.key);
    })
    .map((entry) => entry.provider);
}

export async function getGeocodingProviders(): Promise<GeocodingProvider[]> {
  return (await resolveEnabled('geocoding')) as GeocodingProvider[];
}

export async function getCompanyProviders(): Promise<CompanyProvider[]> {
  return (await resolveEnabled('company')) as CompanyProvider[];
}

export async function getJobProviders(): Promise<JobProvider[]> {
  return (await resolveEnabled('job')) as JobProvider[];
}

export async function getCandidateProviders(): Promise<CandidateProvider[]> {
  return (await resolveEnabled('candidate')) as CandidateProvider[];
}

/** Convenience: the first available geocoder. */
export async function getGeocoder(): Promise<GeocodingProvider | undefined> {
  return (await getGeocodingProviders())[0];
}
