import {
  canonicalizeSkill,
  type Candidate,
  type Company,
  type Job,
  jaccardSimilarity,
  type MatchComponentScore,
  type MatchEvidence,
  type MatchResult,
  normalizeJobTitle,
  type SearchQuery,
  SENIORITY_RANK,
  trigramSimilarity,
} from '@ejc/shared';

import {
  CANDIDATE_WEIGHTS,
  DEFAULT_WEIGHTS,
  POTENTIAL_EMPLOYER_WEIGHTS,
  type ScoringWeights,
} from './weights';

/**
 * The matching engine (plan sections 19 and 20).
 *
 * Two rules shape this module:
 *   - an LLM never produces the score. Every number here is computed from
 *     comparable facts, so results are stable, explainable and testable.
 *   - every component contributes evidence, so the UI can always answer
 *     "why is this a 92%?" with concrete ticks and warnings.
 */

export interface ScoreContext {
  /** Straight-line distance to the search centre, when known. */
  distanceKm?: number | undefined;
  /** Cosine similarity of query/subject embeddings, 0..1, when available. */
  semanticSimilarity?: number | undefined;
  weights?: Partial<ScoringWeights>;
  /** Used for freshness scoring; injectable for deterministic tests. */
  now?: Date;
}

interface Accumulator {
  components: MatchComponentScore[];
  evidence: MatchEvidence[];
  rejectionReasons: string[];
}

function add(
  acc: Accumulator,
  component: string,
  score: number,
  weight: number,
  detail?: string,
): void {
  if (weight <= 0) return;
  const entry: MatchComponentScore = {
    component,
    score: Math.max(0, Math.min(1, score)),
    weight,
  };
  if (detail) entry.detail = detail;
  acc.components.push(entry);
}

function evidence(
  acc: Accumulator,
  kind: MatchEvidence['kind'],
  component: string,
  label: string,
  sourceUrl?: string,
): void {
  const entry: MatchEvidence = { kind, component, label };
  if (sourceUrl) entry.sourceUrl = sourceUrl;
  acc.evidence.push(entry);
}

function finalize(acc: Accumulator): MatchResult {
  const totalWeight = acc.components.reduce((sum, component) => sum + component.weight, 0);
  const weighted = acc.components.reduce(
    (sum, component) => sum + component.score * component.weight,
    0,
  );
  const score = totalWeight === 0 ? 0 : Math.round((weighted / totalWeight) * 100);

  return {
    score: acc.rejectionReasons.length > 0 ? 0 : score,
    rejected: acc.rejectionReasons.length > 0,
    rejectionReasons: acc.rejectionReasons,
    components: acc.components,
    evidence: acc.evidence,
  };
}

/** Skill coverage with alias folding, plus per-skill evidence. */
function scoreSkills(
  acc: Accumulator,
  wanted: readonly string[],
  present: readonly string[],
  component: string,
  weight: number,
  kindWhenMissing: MatchEvidence['kind'],
): number | undefined {
  if (wanted.length === 0) return undefined;

  const presentSet = new Set(present.map(canonicalizeSkill));
  let matched = 0;

  for (const skill of wanted) {
    const canonical = canonicalizeSkill(skill);
    if (presentSet.has(canonical)) {
      matched += 1;
      evidence(acc, 'match', component, canonical);
    } else {
      evidence(acc, kindWhenMissing, component, canonical);
    }
  }

  const ratio = matched / wanted.length;
  add(acc, component, ratio, weight, `${matched}/${wanted.length} matched`);
  return ratio;
}

/**
 * Distance decay.
 *
 * Linear inside the radius (near is better), zero outside. The hard radius
 * filter is applied separately so this only shapes ranking.
 */
export function distanceScore(distanceKm: number, radiusKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  if (radiusKm <= 0) return 0;
  if (distanceKm >= radiusKm) return 0;
  return 1 - distanceKm / radiusKm;
}

/** Title similarity: token overlap and trigram similarity, whichever is kinder. */
export function roleSimilarity(queryRole: string, title: string): number {
  if (!queryRole.trim() || !title.trim()) return 0;
  const a = normalizeJobTitle(queryRole);
  const b = normalizeJobTitle(title);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(jaccardSimilarity(a, b), trigramSimilarity(a, b));
}

function experienceScore(required: number | undefined, has: number | undefined): number | undefined {
  if (required === undefined) return undefined;
  if (has === undefined) return 0.6; // Unknown experience: neither reward nor punish hard.
  if (has >= required) return 1;
  const shortfall = required - has;
  return Math.max(0, 1 - shortfall / Math.max(required, 1));
}

function freshnessScore(publishedAt: string | undefined, now: Date): number | undefined {
  if (!publishedAt) return undefined;
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return undefined;
  const ageDays = (now.getTime() - published.getTime()) / 86_400_000;
  if (ageDays < 0) return 1;
  if (ageDays <= 7) return 1;
  if (ageDays >= 120) return 0.1;
  return Math.max(0.1, 1 - (ageDays - 7) / 113);
}

/** Scores an active vacancy against the user's query. */
export function scoreJob(
  query: SearchQuery,
  job: Job,
  company: Company | undefined,
  context: ScoreContext = {},
): MatchResult {
  const weights: ScoringWeights = { ...DEFAULT_WEIGHTS, ...context.weights };
  const now = context.now ?? new Date();
  const acc: Accumulator = { components: [], evidence: [], rejectionReasons: [] };

  const jobSkills = [...job.skills, ...job.technologies, ...(company?.technologies ?? [])];

  // --- Hard filters (plan section 19: these can reject a result) -----------
  if (context.distanceKm !== undefined && context.distanceKm > query.radiusKm) {
    acc.rejectionReasons.push(
      `Outside the ${query.radiusKm} km radius (${Math.round(context.distanceKm)} km)`,
    );
  }

  const presentSkills = new Set(jobSkills.map(canonicalizeSkill));
  for (const required of query.requiredSkills) {
    if (!presentSkills.has(canonicalizeSkill(required))) {
      acc.rejectionReasons.push(`Missing required skill: ${required}`);
    }
  }

  if (query.workModels.length > 0 && job.workModel !== 'unknown') {
    if (!query.workModels.includes(job.workModel)) {
      acc.rejectionReasons.push(`Work model ${job.workModel} is excluded`);
    }
  }

  const haystack = `${job.title} ${job.description ?? ''} ${company?.name ?? ''}`.toLowerCase();
  for (const exclusion of query.exclusions) {
    if (exclusion && haystack.includes(exclusion.toLowerCase())) {
      acc.rejectionReasons.push(`Matches exclusion: ${exclusion}`);
    }
  }

  // --- Weighted components -------------------------------------------------
  scoreSkills(acc, query.requiredSkills, jobSkills, 'requiredSkills', weights.requiredSkills, 'miss');
  scoreSkills(
    acc,
    [...query.preferredSkills, ...query.technologies],
    jobSkills,
    'preferredSkills',
    weights.preferredSkills,
    'partial',
  );

  if (query.role) {
    const similarity = roleSimilarity(query.role, job.title);
    add(acc, 'role', similarity, weights.role, `"${job.title}"`);
    if (similarity >= 0.6) evidence(acc, 'match', 'role', `Role matches "${job.title}"`);
    else if (similarity >= 0.3) evidence(acc, 'partial', 'role', `Related role "${job.title}"`);
  }

  if (context.semanticSimilarity !== undefined) {
    add(acc, 'semantic', context.semanticSimilarity, weights.semantic, 'Embedding similarity');
  }

  if (context.distanceKm !== undefined) {
    const score = distanceScore(context.distanceKm, query.radiusKm);
    add(acc, 'distance', score, weights.distance, `${Math.round(context.distanceKm)} km`);
    evidence(
      acc,
      context.distanceKm <= query.radiusKm ? 'match' : 'miss',
      'distance',
      `${Math.round(context.distanceKm)} km away`,
    );
  }

  const experience = experienceScore(job.requiredExperienceYears, query.minExperienceYears);
  if (experience !== undefined) {
    add(acc, 'experience', experience, weights.experience);
    if (experience < 1 && job.requiredExperienceYears !== undefined) {
      evidence(
        acc,
        experience >= 0.6 ? 'partial' : 'miss',
        'experience',
        `Requires ${job.requiredExperienceYears} years experience`,
      );
    }
  }

  if (query.seniority && job.seniority !== 'unknown') {
    const gap = Math.abs(SENIORITY_RANK[query.seniority] - SENIORITY_RANK[job.seniority]);
    add(acc, 'seniority', Math.max(0, 1 - gap / 3), weights.experience, job.seniority);
  }

  if (query.employmentTypes.length > 0 && job.employmentType !== 'unknown') {
    const match = query.employmentTypes.includes(job.employmentType);
    add(acc, 'employmentType', match ? 1 : 0, weights.employmentType, job.employmentType);
    evidence(acc, match ? 'match' : 'miss', 'employmentType', job.employmentType.replace('_', ' '));
  }

  if (query.workModels.length > 0) {
    const match = job.workModel !== 'unknown' && query.workModels.includes(job.workModel);
    add(acc, 'workModel', match ? 1 : job.workModel === 'unknown' ? 0.5 : 0, weights.workModel);
    if (job.workModel !== 'unknown') {
      evidence(acc, match ? 'match' : 'miss', 'workModel', job.workModel);
    }
  }

  if (query.industries.length > 0 && company?.industry) {
    const best = Math.max(
      ...query.industries.map((industry) => trigramSimilarity(industry, company.industry ?? '')),
    );
    add(acc, 'industry', best, weights.industry, company.industry);
  }

  if (query.salaryMin !== undefined) {
    const offered = job.salaryMax ?? job.salaryMin;
    if (offered !== undefined) {
      const ratio = offered / query.salaryMin;
      const score = ratio >= 1 ? 1 : Math.max(0, ratio);
      add(acc, 'salary', score, weights.salary, `${offered} ${job.salaryCurrency ?? ''}`.trim());
      evidence(
        acc,
        ratio >= 1 ? 'match' : 'partial',
        'salary',
        `Salary ${offered} ${job.salaryCurrency ?? ''}`.trim(),
      );
    }
  }

  const freshness = freshnessScore(job.publishedAt, now);
  if (freshness !== undefined) add(acc, 'freshness', freshness, weights.freshness);

  if (job.isActive) {
    evidence(acc, 'match', 'vacancy', 'Active vacancy', job.applicationUrl ?? job.sources[0]?.url);
  }

  return finalize(acc);
}

/**
 * Scores a company with no active vacancy (plan section 18).
 *
 * The signal is "does this company plausibly employ people like you": the
 * technologies it uses, its industry, and how close it is.
 */
export function scorePotentialEmployer(
  query: SearchQuery,
  company: Company,
  context: ScoreContext = {},
): MatchResult {
  const weights: ScoringWeights = { ...POTENTIAL_EMPLOYER_WEIGHTS, ...context.weights };
  const acc: Accumulator = { components: [], evidence: [], rejectionReasons: [] };

  const companySkills = [...company.technologies, ...company.services];

  if (context.distanceKm !== undefined && context.distanceKm > query.radiusKm) {
    acc.rejectionReasons.push(
      `Outside the ${query.radiusKm} km radius (${Math.round(context.distanceKm)} km)`,
    );
  }

  const haystack = `${company.name} ${company.description ?? ''}`.toLowerCase();
  for (const exclusion of query.exclusions) {
    if (exclusion && haystack.includes(exclusion.toLowerCase())) {
      acc.rejectionReasons.push(`Matches exclusion: ${exclusion}`);
    }
  }

  // Required skills do not reject a potential employer: absence of evidence on
  // a website is not evidence the company does not use the technology.
  scoreSkills(
    acc,
    query.requiredSkills,
    companySkills,
    'requiredSkills',
    weights.requiredSkills,
    'partial',
  );
  scoreSkills(
    acc,
    [...query.preferredSkills, ...query.technologies],
    companySkills,
    'preferredSkills',
    weights.preferredSkills,
    'partial',
  );

  if (query.role && company.description) {
    const similarity = Math.max(
      roleSimilarity(query.role, company.description),
      roleSimilarity(query.role, company.industry ?? ''),
    );
    add(acc, 'role', similarity, weights.role);
  }

  if (context.semanticSimilarity !== undefined) {
    add(acc, 'semantic', context.semanticSimilarity, weights.semantic, 'Embedding similarity');
  }

  if (context.distanceKm !== undefined) {
    add(acc, 'distance', distanceScore(context.distanceKm, query.radiusKm), weights.distance);
    evidence(acc, 'match', 'distance', `${Math.round(context.distanceKm)} km away`);
  }

  if (query.industries.length > 0 && company.industry) {
    const best = Math.max(
      ...query.industries.map((industry) => trigramSimilarity(industry, company.industry ?? '')),
    );
    add(acc, 'industry', best, weights.industry, company.industry);
  }

  evidence(
    acc,
    'info',
    'vacancy',
    'No active vacancy found — unsolicited application may be relevant',
    company.careerPageUrl ?? company.website,
  );

  return finalize(acc);
}

/** Scores a public professional profile against a hiring query. */
export function scoreCandidate(
  query: SearchQuery,
  candidate: Candidate,
  context: ScoreContext = {},
): MatchResult {
  const weights: ScoringWeights = { ...CANDIDATE_WEIGHTS, ...context.weights };
  const acc: Accumulator = { components: [], evidence: [], rejectionReasons: [] };

  const skills = [...candidate.skills, ...candidate.technologies];

  if (context.distanceKm !== undefined && context.distanceKm > query.radiusKm) {
    acc.rejectionReasons.push(
      `Outside the ${query.radiusKm} km radius (${Math.round(context.distanceKm)} km)`,
    );
  }

  const presentSkills = new Set(skills.map(canonicalizeSkill));
  for (const required of query.requiredSkills) {
    if (!presentSkills.has(canonicalizeSkill(required))) {
      acc.rejectionReasons.push(`Missing required skill: ${required}`);
    }
  }

  scoreSkills(acc, query.requiredSkills, skills, 'requiredSkills', weights.requiredSkills, 'miss');
  scoreSkills(
    acc,
    [...query.preferredSkills, ...query.technologies],
    skills,
    'preferredSkills',
    weights.preferredSkills,
    'partial',
  );

  if (query.role && candidate.publicTitle) {
    const similarity = roleSimilarity(query.role, candidate.publicTitle);
    add(acc, 'role', similarity, weights.role, candidate.publicTitle);
    if (similarity >= 0.5) {
      evidence(acc, 'match', 'role', candidate.publicTitle, candidate.profileUrl);
    }
  }

  if (context.semanticSimilarity !== undefined) {
    add(acc, 'semantic', context.semanticSimilarity, weights.semantic);
  }

  if (context.distanceKm !== undefined) {
    add(acc, 'distance', distanceScore(context.distanceKm, query.radiusKm), weights.distance);
    evidence(acc, 'match', 'distance', `${Math.round(context.distanceKm)} km away`);
  }

  evidence(acc, 'info', 'source', 'Public professional profile', candidate.profileUrl);

  return finalize(acc);
}
