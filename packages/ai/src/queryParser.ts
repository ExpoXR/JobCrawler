import {
  canonicalizeSkills,
  detectEmploymentType,
  detectSeniority,
  detectWorkModel,
  type EmploymentType,
  extractExperienceYears,
  extractLanguages,
  extractSkills,
  getLogger,
  normalizeText,
  type ParsedQuery,
  parsedQuerySchema,
  type SearchQuery,
  type WorkModel,
} from '@ejc/shared';

import { getAiProvider } from './providers';

/**
 * Natural-language search parsing (plan section 6).
 *
 * The heuristic parser is the primary implementation, not a fallback of last
 * resort: it is deterministic, instant, free, and works offline. The AI parser
 * runs on top of it when a provider is configured, and its output is validated
 * and merged rather than trusted wholesale.
 */

interface LocationHint {
  locationText: string;
  radiusKm?: number;
}

const RADIUS_PATTERNS = [
  /(?:within|innerhalb\s+von|im\s+umkreis\s+von|umkreis|radius|dans\s+un\s+rayon\s+de)\s*(\d{1,4})\s*(km|kilometer|kilometre|kilometres|kilometers)/i,
  /(\d{1,4})\s*(?:km|kilometer)\s*(?:around|um|von|from|de)/i,
];

const LOCATION_PATTERNS = [
  // Anchored to the radius phrase: "within 40 km of Kempten", "30 km um Memmingen".
  // Tried first because "of"/"from" are too common to match on their own.
  /(?:km|kilometers?|kilometres?)\s+(?:of|from|von|around|um|bei)\s+([A-ZÄÖÜ][\p{L}.'-]*(?:[ -][A-ZÄÖÜ][\p{L}.'-]*){0,3})/u,
  /(?:in|near|around|bei|um|nahe|rund\s+um|autour\s+de|cerca\s+de)\s+([A-ZÄÖÜ][\p{L}.'-]*(?:[ -][A-ZÄÖÜ][\p{L}.'-]*){0,3})/u,
  /(?:standort|location|ort)\s*[:=]\s*([\p{L} .'-]{2,60})/iu,
];

/** Pulls "within 40 km of Kempten" apart into a place and a radius. */
export function extractLocationHint(text: string): LocationHint | undefined {
  let radiusKm: number | undefined;
  for (const pattern of RADIUS_PATTERNS) {
    const match = text.match(pattern);
    const captured = match?.[1];
    if (captured) {
      const value = Number.parseInt(captured, 10);
      if (Number.isFinite(value) && value > 0 && value <= 5000) {
        radiusKm = value;
        break;
      }
    }
  }

  for (const pattern of LOCATION_PATTERNS) {
    const match = text.match(pattern);
    const captured = match?.[1]?.trim();
    if (captured && captured.length >= 2) {
      // The pattern allows an internal full stop so that "St. Gallen" survives,
      // which means a capitalised word starting the *next* sentence can be
      // swallowed too ("Kempten. I know React" → "Kempten. I"). Cut at the
      // first sentence boundary, then trim any trailing punctuation.
      // A full stop after a short token is an abbreviation ("St. Gallen");
      // after a full word it ends the sentence.
      const cleaned = (captured.split(/(?<=\p{L}{4})\.\s+/u)[0] ?? captured)
        .replace(/\s+(?:and|und|with|mit|i know|ich kann)\b.*$/i, '')
        .replace(/[.,;:]+$/, '')
        .trim();
      const hint: LocationHint = { locationText: cleaned };
      if (radiusKm !== undefined) hint.radiusKm = radiusKm;
      return hint;
    }
  }

  return radiusKm === undefined ? undefined : { locationText: '', radiusKm };
}

const ROLE_PATTERNS = [
  // The trailing noun group must not include a role noun ("developer jobs"),
  // or the non-greedy capture stops early and yields "frontend" instead of
  // "frontend developer".
  /(?:find|search\s+for|looking\s+for|suche|finde|ich\s+suche)\s+(?:me\s+)?(?:a\s+|an\s+|einen\s+|eine\s+|ein\s+)?([\p{L}/. +#-]{3,60}?)\s*(?:jobs?|stellen|positions?|roles?)?\s*(?:\bin\b|\bnear\b|\baround\b|\bbei\b|\bum\b|\bwithin\b|$|,|\.)/iu,
  /\b((?:senior|junior|lead|principal)?\s*[\p{L}.+#-]+(?:\s+[\p{L}.+#-]+){0,2}\s+(?:developer|engineer|designer|manager|entwickler|entwicklerin|architekt|consultant|analyst|scientist|administrator))\b/iu,
];

export function extractRole(text: string): string | undefined {
  for (const pattern of ROLE_PATTERNS) {
    const match = text.match(pattern);
    const captured = match?.[1]?.trim();
    if (captured && captured.length >= 3 && captured.length <= 80) {
      return captured.replace(/\s+/g, ' ');
    }
  }
  return undefined;
}

const EXCLUSION_PATTERN =
  /(?:not|no|kein|keine|ohne|exclude|without|nicht)\s+([\p{L}. +#-]{2,40}?)(?:[,.;]|$| and | und )/giu;

export function extractExclusions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(EXCLUSION_PATTERN)) {
    const value = match[1]?.trim();
    if (value && value.length >= 2) found.add(value);
  }
  return [...found].slice(0, 10);
}

const SALARY_PATTERN =
  /(?:at\s+least|mindestens|min\.?|from|ab)?\s*(\d{2,3})[.,]?(\d{3})?\s*(k|000)?\s*(eur|euro|€|chf|gbp|£|usd|\$)/i;

export function extractSalary(text: string): { salaryMin?: number; salaryCurrency?: string } {
  const match = text.match(SALARY_PATTERN);
  if (!match) return {};

  const lead = Number.parseInt(match[1] ?? '0', 10);
  const tail = match[2];
  const suffix = match[3]?.toLowerCase();

  let amount = lead;
  if (tail) amount = Number.parseInt(`${match[1]}${tail}`, 10);
  else if (suffix === 'k' || suffix === '000') amount = lead * 1000;
  if (!Number.isFinite(amount) || amount <= 0) return {};
  // A bare "60" almost certainly means 60k, not €60.
  if (amount < 1000) amount *= 1000;

  const currencyToken = (match[4] ?? '').toLowerCase();
  const currency =
    currencyToken === '€' || currencyToken.startsWith('eur')
      ? 'EUR'
      : currencyToken === '£' || currencyToken === 'gbp'
        ? 'GBP'
        : currencyToken === '$' || currencyToken === 'usd'
          ? 'USD'
          : currencyToken === 'chf'
            ? 'CHF'
            : undefined;

  return currency ? { salaryMin: amount, salaryCurrency: currency } : { salaryMin: amount };
}

const COMPANY_SIZE_HINTS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\b(startup|start-up)\b/i, value: 'startup' },
  { pattern: /\b(small|kleine|klein|smaller|agency|agentur|agencies|agenturen)\b/i, value: 'small' },
  { pattern: /\b(mittelstand|medium|mittelgro)/i, value: 'medium' },
  { pattern: /\b(enterprise|konzern|large|gro(?:ss|ß)e)\b/i, value: 'large' },
];

/**
 * Deterministic query parsing. Always available, never charged for, and the
 * reference behaviour that the AI parser is merged into.
 */
export function parseQueryHeuristically(text: string): ParsedQuery {
  const parsed: ParsedQuery = {};

  const location = extractLocationHint(text);
  if (location?.locationText) parsed.locationText = location.locationText;
  if (location?.radiusKm !== undefined) parsed.radiusKm = location.radiusKm;

  const role = extractRole(text);
  if (role) parsed.role = role;

  const skills = canonicalizeSkills(extractSkills(text));
  if (skills.length > 0) {
    // "I know X" reads as capability, so treat mentioned skills as preferred
    // unless the user marked them required. Required-ness comes from the form.
    parsed.preferredSkills = skills;
    parsed.technologies = skills;
  }

  const seniority = detectSeniority(text);
  if (seniority !== 'unknown') parsed.seniority = seniority;

  const employmentType = detectEmploymentType(text);
  if (employmentType !== 'unknown') parsed.employmentTypes = [employmentType];

  const workModel = detectWorkModel(text);
  if (workModel !== 'unknown') parsed.workModels = [workModel];

  const experience = extractExperienceYears(text);
  if (experience !== undefined) parsed.minExperienceYears = experience;

  const languages = extractLanguages(text);
  if (languages.length > 0) parsed.languages = languages;

  const exclusions = extractExclusions(text);
  if (exclusions.length > 0) parsed.exclusions = exclusions;

  const salary = extractSalary(text);
  if (salary.salaryMin !== undefined) parsed.salaryMin = salary.salaryMin;
  if (salary.salaryCurrency) parsed.salaryCurrency = salary.salaryCurrency;

  const sizes = COMPANY_SIZE_HINTS.filter(({ pattern }) => pattern.test(text)).map(
    ({ value }) => value,
  );
  if (sizes.length > 0) parsed.companySizes = [...new Set(sizes)];

  return parsed;
}

const SYSTEM_PROMPT = `You convert job-search requests into structured filters.
Reply with a single JSON object and nothing else.
Allowed keys: locationText, radiusKm, role, requiredSkills, preferredSkills, technologies,
seniority, minExperienceYears, employmentTypes, workModels, industries, languages,
companySizes, salaryMin, salaryCurrency, keywords, exclusions.
seniority must be one of: intern, junior, mid, senior, lead, principal, executive, unknown.
employmentTypes entries must be one of: full_time, part_time, contract, freelance, internship,
temporary, apprenticeship, unknown.
workModels entries must be one of: remote, hybrid, onsite, unknown.
Omit any key you cannot determine. Never invent a location.`;

/** Pulls the first JSON object out of a model response. */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Merges the AI's reading over the heuristic one.
 *
 * The heuristic result wins on anything the AI left blank, and array fields are
 * unioned, so enabling AI can only add signal — never silently drop a filter
 * the deterministic parser already found.
 */
export function mergeParsedQueries(base: ParsedQuery, overlay: ParsedQuery): ParsedQuery {
  const merged: ParsedQuery = { ...base };

  for (const [key, value] of Object.entries(overlay) as Array<[keyof ParsedQuery, unknown]>) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const existing = (merged[key] as unknown[] | undefined) ?? [];
      const union = [...new Set([...existing, ...value])];
      (merged as Record<string, unknown>)[key] = union;
    } else if (typeof value === 'string') {
      if (value.trim()) (merged as Record<string, unknown>)[key] = value.trim();
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  return merged;
}

export interface ParseOptions {
  signal?: AbortSignal;
  /** Skip the AI call even when a provider is configured. */
  heuristicOnly?: boolean;
}

export interface ParseResult {
  parsed: ParsedQuery;
  usedAi: boolean;
}

/** Parses free text into structured filters, using AI when it is available. */
export async function parseNaturalLanguageQuery(
  text: string,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const heuristic = parseQueryHeuristically(text);
  const provider = getAiProvider();

  if (options.heuristicOnly || !provider.configured) {
    return { parsed: heuristic, usedAi: false };
  }

  try {
    const completion = await provider.complete({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text.slice(0, 4000) },
      ],
      json: true,
      temperature: 0,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const candidate = extractJsonObject(completion.text);
    const validated = parsedQuerySchema.safeParse(candidate);
    if (!validated.success) {
      getLogger('ai').warn('AI query parse failed validation', { provider: provider.key });
      return { parsed: heuristic, usedAi: false };
    }

    return { parsed: mergeParsedQueries(heuristic, validated.data), usedAi: true };
  } catch (error) {
    // An AI outage must never break search (plan section 35).
    getLogger('ai').warn('AI query parse failed', {
      provider: provider.key,
      errorType: 'ai_failure',
      message: error instanceof Error ? error.message : String(error),
    });
    return { parsed: heuristic, usedAi: false };
  }
}

/** Applies parsed filters onto a base search query. */
export function applyParsedQuery(base: SearchQuery, parsed: ParsedQuery): SearchQuery {
  const merged: SearchQuery = { ...base };

  if (parsed.locationText && !base.locationText) merged.locationText = parsed.locationText;
  if (parsed.radiusKm !== undefined) merged.radiusKm = parsed.radiusKm;
  if (parsed.role && !base.role) merged.role = parsed.role;
  if (parsed.seniority) merged.seniority = parsed.seniority;
  if (parsed.minExperienceYears !== undefined) {
    merged.minExperienceYears = parsed.minExperienceYears;
  }
  if (parsed.salaryMin !== undefined) merged.salaryMin = parsed.salaryMin;
  if (parsed.salaryCurrency) merged.salaryCurrency = parsed.salaryCurrency;

  const union = (a: readonly string[], b: readonly string[] | undefined) => [
    ...new Set([...a, ...(b ?? [])]),
  ];

  merged.requiredSkills = union(base.requiredSkills, parsed.requiredSkills);
  merged.preferredSkills = union(base.preferredSkills, parsed.preferredSkills);
  merged.technologies = union(base.technologies, parsed.technologies);
  merged.industries = union(base.industries, parsed.industries);
  merged.languages = union(base.languages, parsed.languages);
  merged.companySizes = union(base.companySizes, parsed.companySizes);
  merged.keywords = union(base.keywords, parsed.keywords);
  merged.exclusions = union(base.exclusions, parsed.exclusions);

  if (parsed.employmentTypes?.length) {
    merged.employmentTypes = [
      ...new Set([...base.employmentTypes, ...parsed.employmentTypes]),
    ] as EmploymentType[];
  }
  if (parsed.workModels?.length) {
    merged.workModels = [...new Set([...base.workModels, ...parsed.workModels])] as WorkModel[];
  }

  return merged;
}

/**
 * Extracts requirements from a pasted job description (plan section 5.2).
 * Reuses the same machinery, then promotes explicit "required" skills.
 */
export async function parseJobDescription(
  description: string,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const result = await parseNaturalLanguageQuery(description, options);

  const normalized = normalizeText(description);
  const requiredSection = normalized.split(/(?:nice to have|wuenschenswert|plus|bonus)/)[0] ?? '';
  const required = canonicalizeSkills(extractSkills(requiredSection));

  if (required.length > 0) {
    result.parsed.requiredSkills = [
      ...new Set([...(result.parsed.requiredSkills ?? []), ...required]),
    ];
  }

  return result;
}
