# Providers

Every external source is a provider. Adding one must not require changes
anywhere else in the application — the search orchestrator asks the registry for
"all enabled company providers" and never names a specific source.

## Contracts

Defined in `packages/providers/src/types.ts`:

```ts
interface GeocodingProvider  { geocode(query, ctx): Promise<GeoLocation[]> }
interface CompanyProvider    { discoverCompanies(query, ctx): Promise<DiscoveredCompany[]> }
interface JobProvider        { searchJobs(query, ctx): Promise<DiscoveredJob[]> }
interface CandidateProvider  { searchCandidates(query, ctx): Promise<DiscoveredCandidate[]> }
```

Each also implements `BaseProvider`:

```ts
readonly info: ProviderInfo;   // key, name, capabilities, rate limit, homepage
isAvailable(): boolean;        // false when required configuration is missing
```

Capabilities are advertised, not inferred: `direct-crawling`, `api-search`,
`metadata-extraction`, `profile-discovery`, `external-link-only`, `geocoding`,
`reverse-geocoding`, `radius-search`, `structured-jobs`.

## Shipped providers

| Key | Kind | Notes |
| --- | --- | --- |
| `nominatim` | geocoding | OSM geocoding. Results cached 30 days in `geocode_cache`; honours the OSM usage policy (identifying User-Agent, no bulk queries). Point `NOMINATIM_BASE_URL` at a self-hosted instance for production volume. |
| `overpass` | company | Finds employers inside the radius from OSM `office`/`craft`/`industrial` tags. Bounded by radius and result count with a server-side timeout. |
| `career-page` | job | Crawls the employer's own site. The authoritative source, and the one that surfaces vacancies no job board carries. |
| `github` | candidate | Public profile search. Only fields GitHub itself publishes; no email harvesting. Set `GITHUB_TOKEN` to raise the rate limit. |

## Adding a provider

1. Create `packages/providers/src/<kind>/<name>.ts` implementing the interface.
2. Fill in `info` honestly — especially `rateLimitPerMinute` and
   `requiresCredentials`.
3. Return `false` from `isAvailable()` when configuration is missing, so the
   provider is skipped rather than throwing on every search.
4. Register it in `packages/providers/src/registry.ts`:

```ts
registerProvider(myProvider, 'job');
```

5. Export it from `packages/providers/src/index.ts`.

`syncProviderRegistry()` mirrors the code-defined providers into the
`source_providers` table on worker boot and whenever the admin providers
endpoint is read, so a new provider appears in the dashboard automatically and
an operator can disable it without a deploy.

### Rules a provider must follow

- **Respect the source's terms.** If an API forbids caching or redistribution,
  the provider must honour that; if it requires attribution, surface it.
- **Never bypass access controls.** No CAPTCHA solving, no authentication
  replay, no paywall circumvention, no bot-protection evasion.
- **Fail soft.** Throw `AppError` with an appropriate type. The orchestrator
  records the failure against the search and continues with other providers.
- **Respect cancellation.** Honour `context.signal`; searches have a deadline.
- **Return provenance.** Every discovered entity carries the URL it came from.
  A result the user cannot verify is not worth showing.

### Testing a provider

Providers are I/O boundaries, so test the pure parts directly — query building,
response mapping, capability reporting — and inject a fake fetch/resolver for
the rest. `OverpassProvider.buildQuery` and
`GitHubCandidateProvider.buildSearchQuery` are public for exactly this reason.
