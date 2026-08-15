import { foldText, normalizeText } from './text';
import type { EmploymentType, Seniority, WorkModel } from './types';

/**
 * Multilingual vocabulary used by the crawler, the extractors and the
 * heuristic query parser.
 *
 * This is the layer that lets the MVP work with no AI provider configured at
 * all: German/English/French/Dutch/Spanish/Italian keywords map onto the same
 * canonical values that an LLM would otherwise produce.
 */

/** URL path fragments that mark a page as worth fetching (plan section 9). */
export const CAREER_URL_PATTERNS = [
  'career',
  'careers',
  'karriere',
  'job',
  'jobs',
  'stelle',
  'stellen',
  'stellenangebote',
  'stellenanzeigen',
  'arbeiten',
  'arbeiten-bei',
  'work',
  'work-with-us',
  'join-us',
  'join',
  'vacancy',
  'vacancies',
  'vacatures',
  'offres-emploi',
  'emploi',
  'recrutement',
  'empleo',
  'trabaja-con-nosotros',
  'lavora-con-noi',
  'offerte-lavoro',
  'praktikum',
  'ausbildung',
  'hiring',
  'wir-suchen',
  'open-positions',
  'positions',
] as const;

/** Pages that describe the company itself: useful for potential-employer scoring. */
export const COMPANY_URL_PATTERNS = [
  'team',
  'about',
  'about-us',
  'ueber-uns',
  'uber-uns',
  'unternehmen',
  'company',
  'wir',
  'technologies',
  'technology',
  'tech-stack',
  'stack',
  'leistungen',
  'services',
  'solutions',
  'produkte',
  'products',
  'referenzen',
  'portfolio',
  'projekte',
  'projects',
  'cases',
  'kontakt',
  'contact',
  'impressum',
  'imprint',
] as const;

export type PageCategory = 'career' | 'job' | 'company' | 'contact' | 'other';

const CONTACT_PATTERNS = ['kontakt', 'contact', 'impressum', 'imprint', 'mentions-legales'];

/**
 * Classifies a URL path by relevance. `job` is reserved for URLs that look like
 * an individual posting rather than an index page.
 */
export function classifyUrlPath(rawUrl: string): { category: PageCategory; score: number } {
  let path: string;
  try {
    const parsed = new URL(rawUrl);
    path = `${parsed.pathname}`.toLowerCase();
  } catch {
    path = rawUrl.toLowerCase();
  }

  const segments = foldText(path)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = segments.join('-');

  const hasPattern = (patterns: readonly string[]) =>
    patterns.some(
      (pattern) => segments.includes(pattern) || joined.includes(pattern.replace(/\s+/g, '-')),
    );

  if (hasPattern(CAREER_URL_PATTERNS)) {
    // A deep path under a careers section is usually a single posting.
    const looksLikePosting = segments.length >= 3 || /\d{3,}/.test(joined);
    return { category: looksLikePosting ? 'job' : 'career', score: looksLikePosting ? 1 : 0.9 };
  }
  if (hasPattern(CONTACT_PATTERNS)) return { category: 'contact', score: 0.5 };
  if (hasPattern(COMPANY_URL_PATTERNS)) return { category: 'company', score: 0.6 };
  if (segments.length === 0) return { category: 'company', score: 0.7 };
  return { category: 'other', score: 0.1 };
}

interface KeywordRule<T> {
  value: T;
  keywords: string[];
}

function matchKeyword<T>(haystack: string, rules: readonly KeywordRule<T>[]): T | undefined {
  const normalized = ` ${normalizeText(haystack)} `;
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (normalized.includes(` ${normalizeText(keyword)} `)) return rule.value;
      if (normalizeText(keyword).includes(' ') && normalized.includes(normalizeText(keyword))) {
        return rule.value;
      }
    }
  }
  return undefined;
}

const WORK_MODEL_RULES: KeywordRule<WorkModel>[] = [
  { value: 'remote', keywords: ['remote', 'homeoffice', 'home office', 'telearbeit', 'teletravail', 'full remote', '100% remote'] },
  { value: 'hybrid', keywords: ['hybrid', 'hybrides arbeiten', 'teilweise remote', 'partly remote', 'flexible office'] },
  { value: 'onsite', keywords: ['on-site', 'onsite', 'vor ort', 'praesenz', 'im buero', 'in office', 'presencial'] },
];

export function detectWorkModel(text: string): WorkModel {
  // Hybrid wins over remote when both appear: it is the more specific claim.
  const normalized = normalizeText(text);
  if (matchKeyword(normalized, [WORK_MODEL_RULES[1] as KeywordRule<WorkModel>])) return 'hybrid';
  return matchKeyword(normalized, WORK_MODEL_RULES) ?? 'unknown';
}

const EMPLOYMENT_TYPE_RULES: KeywordRule<EmploymentType>[] = [
  { value: 'internship', keywords: ['internship', 'intern', 'praktikum', 'praktikant', 'stage', 'werkstudent', 'working student'] },
  { value: 'apprenticeship', keywords: ['apprenticeship', 'ausbildung', 'auszubildende', 'azubi', 'duales studium', 'alternance'] },
  { value: 'freelance', keywords: ['freelance', 'freelancer', 'freiberuflich', 'selbststaendig', 'independant'] },
  { value: 'contract', keywords: ['contract', 'contractor', 'befristet', 'fixed term', 'fixed-term', 'interim', 'cdd'] },
  { value: 'temporary', keywords: ['temporary', 'aushilfe', 'saisonal', 'seasonal', 'zeitarbeit'] },
  { value: 'part_time', keywords: ['part-time', 'part time', 'teilzeit', 'temps partiel', 'parttime', 'deeltijd'] },
  { value: 'full_time', keywords: ['full-time', 'full time', 'vollzeit', 'temps plein', 'fulltime', 'voltijd', 'permanent', 'unbefristet'] },
];

export function detectEmploymentType(text: string): EmploymentType {
  return matchKeyword(text, EMPLOYMENT_TYPE_RULES) ?? 'unknown';
}

/** Maps schema.org employmentType tokens onto our canonical enum. */
export function employmentTypeFromSchemaOrg(value: string): EmploymentType {
  const normalized = value.toUpperCase().replace(/[^A-Z]/g, '_');
  const map: Record<string, EmploymentType> = {
    FULL_TIME: 'full_time',
    PART_TIME: 'part_time',
    CONTRACTOR: 'contract',
    TEMPORARY: 'temporary',
    INTERN: 'internship',
    VOLUNTEER: 'unknown',
    PER_DIEM: 'temporary',
    OTHER: 'unknown',
  };
  return map[normalized] ?? detectEmploymentType(value);
}

const SENIORITY_RULES: KeywordRule<Seniority>[] = [
  { value: 'intern', keywords: ['intern', 'praktikant', 'werkstudent', 'trainee'] },
  { value: 'junior', keywords: ['junior', 'entry level', 'einsteiger', 'berufseinsteiger', 'graduate', 'nachwuchs'] },
  { value: 'principal', keywords: ['principal', 'staff engineer', 'fellow'] },
  { value: 'executive', keywords: ['head of', 'director', 'cto', 'ceo', 'vp ', 'geschaeftsfuehrer', 'leiter'] },
  { value: 'lead', keywords: ['lead', 'teamlead', 'team lead', 'teamleiter', 'tech lead', 'leitung'] },
  { value: 'senior', keywords: ['senior', 'erfahren', 'experienced', 'expert'] },
  { value: 'mid', keywords: ['mid-level', 'mid level', 'regular', 'professional'] },
];

export function detectSeniority(text: string): Seniority {
  return matchKeyword(text, SENIORITY_RULES) ?? 'unknown';
}

export const SENIORITY_RANK: Record<Seniority, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  principal: 5,
  executive: 6,
  unknown: 2,
};

/**
 * Canonical skill/technology dictionary with aliases.
 *
 * Extending this list is the cheapest way to improve extraction quality; the
 * matching engine works purely off the canonical names.
 */
export const SKILL_ALIASES: Record<string, string[]> = {
  react: ['react', 'react.js', 'reactjs'],
  'next.js': ['next.js', 'nextjs', 'next js'],
  vue: ['vue', 'vue.js', 'vuejs'],
  nuxt: ['nuxt', 'nuxt.js', 'nuxtjs'],
  angular: ['angular', 'angularjs'],
  svelte: ['svelte', 'sveltekit'],
  typescript: ['typescript', 'ts'],
  javascript: ['javascript', 'js', 'ecmascript'],
  'node.js': ['node.js', 'nodejs', 'node js', 'node'],
  deno: ['deno'],
  bun: ['bun'],
  php: ['php'],
  laravel: ['laravel'],
  symfony: ['symfony'],
  wordpress: ['wordpress', 'wp'],
  typo3: ['typo3'],
  drupal: ['drupal'],
  shopware: ['shopware'],
  shopify: ['shopify'],
  magento: ['magento', 'adobe commerce'],
  python: ['python'],
  django: ['django'],
  flask: ['flask'],
  fastapi: ['fastapi'],
  java: ['java'],
  spring: ['spring', 'spring boot', 'springboot'],
  kotlin: ['kotlin'],
  'c#': ['c#', 'csharp', 'c sharp'],
  '.net': ['.net', 'dotnet', 'asp.net', 'aspnet'],
  go: ['golang', 'go lang'],
  rust: ['rust'],
  ruby: ['ruby'],
  rails: ['rails', 'ruby on rails'],
  swift: ['swift'],
  'objective-c': ['objective-c', 'objective c'],
  flutter: ['flutter'],
  dart: ['dart'],
  'react native': ['react native', 'react-native'],
  html: ['html', 'html5'],
  css: ['css', 'css3'],
  sass: ['sass', 'scss'],
  tailwind: ['tailwind', 'tailwindcss', 'tailwind css'],
  bootstrap: ['bootstrap'],
  graphql: ['graphql'],
  rest: ['rest', 'rest api', 'restful'],
  grpc: ['grpc'],
  postgresql: ['postgresql', 'postgres', 'psql'],
  mysql: ['mysql', 'mariadb'],
  mongodb: ['mongodb', 'mongo'],
  redis: ['redis'],
  elasticsearch: ['elasticsearch', 'elastic search', 'opensearch'],
  docker: ['docker'],
  kubernetes: ['kubernetes', 'k8s'],
  terraform: ['terraform'],
  ansible: ['ansible'],
  aws: ['aws', 'amazon web services'],
  azure: ['azure', 'microsoft azure'],
  gcp: ['gcp', 'google cloud', 'google cloud platform'],
  linux: ['linux', 'ubuntu', 'debian'],
  nginx: ['nginx'],
  git: ['git', 'github', 'gitlab'],
  'ci/cd': ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery'],
  jenkins: ['jenkins'],
  figma: ['figma'],
  'ui design': ['ui design', 'ui-design'],
  'ux design': ['ux design', 'ux-design', 'user experience'],
  seo: ['seo', 'suchmaschinenoptimierung'],
  'three.js': ['three.js', 'threejs'],
  webgl: ['webgl'],
  webxr: ['webxr'],
  unity: ['unity', 'unity3d'],
  'unreal engine': ['unreal engine', 'unreal', 'ue5'],
  blender: ['blender'],
  'machine learning': ['machine learning', 'maschinelles lernen', 'ml'],
  pytorch: ['pytorch'],
  tensorflow: ['tensorflow'],
  scrum: ['scrum'],
  agile: ['agile', 'agil'],
  jira: ['jira'],
  sql: ['sql'],
  'power bi': ['power bi', 'powerbi'],
  sap: ['sap'],
  salesforce: ['salesforce'],
  hubspot: ['hubspot'],
};

const ALIAS_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
    map.set(normalizeText(canonical), canonical);
    for (const alias of aliases) map.set(normalizeText(alias), canonical);
  }
  return map;
})();

/** Resolves a free-form skill string to its canonical name, if known. */
export function canonicalizeSkill(input: string): string {
  const normalized = normalizeText(input);
  return ALIAS_LOOKUP.get(normalized) ?? normalized;
}

export function canonicalizeSkills(inputs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const input of inputs) {
    const canonical = canonicalizeSkill(input);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Anchored matcher for one alias.
 *
 * `normalizeText` keeps `.`, `/`, `+`, `#` and `-` because technology names
 * need them ("next.js", "c#", "ci/cd"), which means a plain space-delimited
 * search misses "TypeScript." at the end of a sentence and, worse, would let
 * "node" match inside "node.js". The lookahead therefore treats a full stop as
 * a boundary only when a space or the end of the string follows it.
 */
function aliasPattern(alias: string): RegExp {
  return new RegExp(`(?:^|[\\s(,;/])${escapeRegExp(alias)}(?=$|[\\s,;/)-]|\\.(?:\\s|$))`);
}

const ALIAS_PATTERNS: Array<[RegExp, string]> = [...ALIAS_LOOKUP].map(([alias, canonical]) => [
  aliasPattern(alias),
  canonical,
]);

/**
 * Finds known skills mentioned in free text. Word-boundary aware so that
 * "go" does not match "google" and a trailing full stop does not hide a match.
 */
export function extractSkills(text: string, limit = 40): string[] {
  const normalized = ` ${normalizeText(text)} `;
  const found = new Set<string>();

  for (const [pattern, canonical] of ALIAS_PATTERNS) {
    if (found.has(canonical)) continue;
    if (pattern.test(normalized)) {
      found.add(canonical);
      if (found.size >= limit) break;
    }
  }
  return [...found];
}

const LANGUAGE_RULES: KeywordRule<string>[] = [
  { value: 'de', keywords: ['german', 'deutsch', 'deutschkenntnisse', 'allemand'] },
  { value: 'en', keywords: ['english', 'englisch', 'anglais'] },
  { value: 'fr', keywords: ['french', 'franzoesisch', 'francais'] },
  { value: 'es', keywords: ['spanish', 'spanisch', 'espanol'] },
  { value: 'it', keywords: ['italian', 'italienisch', 'italiano'] },
  { value: 'nl', keywords: ['dutch', 'niederlaendisch', 'nederlands'] },
  { value: 'pl', keywords: ['polish', 'polnisch', 'polski'] },
];

export function extractLanguages(text: string): string[] {
  const normalized = ` ${normalizeText(text)} `;
  const found = new Set<string>();
  for (const rule of LANGUAGE_RULES) {
    for (const keyword of rule.keywords) {
      if (normalized.includes(` ${normalizeText(keyword)} `)) {
        found.add(rule.value);
        break;
      }
    }
  }
  return [...found];
}

/** Extracts "3+ years" / "mindestens 5 Jahre" style requirements. */
export function extractExperienceYears(text: string): number | undefined {
  const normalized = normalizeText(text);
  const patterns = [
    /(\d{1,2})\s*\+?\s*(?:jahre|jahren|years|year|ans|anni|jaar)/,
    /(?:mindestens|min|at least|minimum)\s*(\d{1,2})\s*(?:jahre|jahren|years|year)/,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const captured = match?.[1];
    if (captured) {
      const years = Number.parseInt(captured, 10);
      if (Number.isFinite(years) && years >= 0 && years <= 50) return years;
    }
  }
  return undefined;
}
