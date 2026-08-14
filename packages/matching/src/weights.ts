/**
 * Scoring weights (plan section 19).
 *
 * The final score is a weighted mean over the components that actually have a
 * signal. Components with no data are dropped and the remaining weights are
 * renormalised, so a job with no salary information is not punished for it —
 * it is simply scored on what is known.
 */

export interface ScoringWeights {
  requiredSkills: number;
  preferredSkills: number;
  semantic: number;
  role: number;
  experience: number;
  distance: number;
  industry: number;
  employmentType: number;
  workModel: number;
  salary: number;
  freshness: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  requiredSkills: 3.0,
  preferredSkills: 1.2,
  semantic: 2.0,
  role: 2.0,
  experience: 1.0,
  distance: 1.5,
  industry: 0.6,
  employmentType: 0.8,
  workModel: 1.0,
  salary: 0.8,
  freshness: 0.5,
};

/**
 * A company with no vacancy is judged on different evidence: what it builds and
 * where it is, not on a job description it does not have.
 */
export const POTENTIAL_EMPLOYER_WEIGHTS: ScoringWeights = {
  ...DEFAULT_WEIGHTS,
  requiredSkills: 2.4,
  preferredSkills: 1.0,
  role: 0.8,
  semantic: 1.6,
  experience: 0,
  employmentType: 0,
  salary: 0,
  freshness: 0,
  distance: 1.8,
  industry: 1.0,
};

export const CANDIDATE_WEIGHTS: ScoringWeights = {
  ...DEFAULT_WEIGHTS,
  employmentType: 0,
  salary: 0,
  freshness: 0.3,
};
