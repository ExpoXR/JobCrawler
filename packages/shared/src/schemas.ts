import { z } from 'zod';

import type { SearchQuery } from './types';

/**
 * Runtime validation for anything crossing a trust boundary: HTTP request
 * bodies, queue payloads, AI responses and scraped structured data.
 */

export const workModelSchema = z.enum(['remote', 'hybrid', 'onsite', 'unknown']);

export const employmentTypeSchema = z.enum([
  'full_time',
  'part_time',
  'contract',
  'freelance',
  'internship',
  'temporary',
  'apprenticeship',
  'unknown',
]);

export const seniorityKeys = [
  'intern',
  'junior',
  'mid',
  'senior',
  'lead',
  'principal',
  'executive',
  'unknown',
] as const;

export const senioritySchema = z.enum(seniorityKeys);

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

export const geoLocationSchema = geoPointSchema.extend({
  label: z.string().min(1),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  countryCode: z.string().length(2).optional(),
  postalCode: z.string().optional(),
  source: z.string().optional(),
});

const stringList = (max = 50) =>
  z
    .array(z.string().trim().min(1).max(120))
    .max(max)
    .default([])
    .transform((values) => Array.from(new Set(values.map((value) => value.trim()))));

export const searchQuerySchema = z.object({
  mode: z.enum(['jobs', 'candidates']).default('jobs'),
  locationText: z.string().trim().min(1).max(200),
  location: geoLocationSchema.optional(),
  radiusKm: z.coerce.number().min(1).max(5000).default(50),
  role: z.string().trim().max(200).default(''),
  requiredSkills: stringList(),
  preferredSkills: stringList(),
  technologies: stringList(),
  seniority: senioritySchema.optional(),
  minExperienceYears: z.coerce.number().min(0).max(60).optional(),
  employmentTypes: z.array(employmentTypeSchema).max(10).default([]),
  workModels: z.array(workModelSchema).max(4).default([]),
  industries: stringList(20),
  languages: stringList(20),
  companySizes: z.array(z.string().max(40)).max(10).default([]),
  salaryMin: z.coerce.number().min(0).max(10_000_000).optional(),
  salaryCurrency: z.string().length(3).optional(),
  keywords: stringList(),
  exclusions: stringList(),
  includePotentialEmployers: z.boolean().default(true),
  minMatchScore: z.coerce.number().min(0).max(100).default(0),
  rawQuery: z.string().max(4000).optional(),
});

export type SearchQueryInput = z.input<typeof searchQuerySchema>;

export function parseSearchQuery(input: unknown): SearchQuery {
  return searchQuerySchema.parse(input) as SearchQuery;
}

export const naturalLanguageQuerySchema = z.object({
  text: z.string().trim().min(3).max(4000),
  mode: z.enum(['jobs', 'candidates']).default('jobs'),
});

export const geocodeRequestSchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export const exportRequestSchema = z.object({
  searchId: z.string().uuid(),
  format: z.enum(['csv', 'json']).default('csv'),
});

/**
 * Structured JobPosting fields we accept from schema.org JSON-LD. Everything is
 * optional because scraped data is never trustworthy (plan section 37).
 */
export const jsonLdJobPostingSchema = z.looseObject({
  '@type': z.union([z.string(), z.array(z.string())]).optional(),
  title: z.string().max(500).optional(),
  description: z.string().max(200_000).optional(),
  datePosted: z.string().max(100).optional(),
  validThrough: z.string().max(100).optional(),
  employmentType: z.union([z.string(), z.array(z.string())]).optional(),
  directApply: z.boolean().optional(),
  hiringOrganization: z
    .union([
      z.string(),
      z.object({
        name: z.string().max(300).optional(),
        sameAs: z.string().max(2000).optional(),
        url: z.string().max(2000).optional(),
      }),
    ])
    .optional(),
  jobLocation: z.unknown().optional(),
  jobLocationType: z.string().max(100).optional(),
  applicantLocationRequirements: z.unknown().optional(),
  baseSalary: z.unknown().optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  qualifications: z.union([z.string(), z.array(z.string())]).optional(),
  experienceRequirements: z.unknown().optional(),
  industry: z.union([z.string(), z.array(z.string())]).optional(),
  url: z.string().max(2000).optional(),
  identifier: z.unknown().optional(),
});

export type JsonLdJobPosting = z.infer<typeof jsonLdJobPostingSchema>;

/** Shape the AI query parser must return. Validated before it is trusted. */
export const parsedQuerySchema = z.object({
  locationText: z.string().max(200).optional(),
  radiusKm: z.number().min(1).max(5000).optional(),
  role: z.string().max(200).optional(),
  requiredSkills: z.array(z.string().max(80)).max(40).optional(),
  preferredSkills: z.array(z.string().max(80)).max(40).optional(),
  technologies: z.array(z.string().max(80)).max(40).optional(),
  seniority: senioritySchema.optional(),
  minExperienceYears: z.number().min(0).max(60).optional(),
  employmentTypes: z.array(employmentTypeSchema).max(8).optional(),
  workModels: z.array(workModelSchema).max(4).optional(),
  industries: z.array(z.string().max(80)).max(20).optional(),
  languages: z.array(z.string().max(40)).max(20).optional(),
  companySizes: z.array(z.string().max(40)).max(10).optional(),
  salaryMin: z.number().min(0).max(10_000_000).optional(),
  salaryCurrency: z.string().max(3).optional(),
  keywords: z.array(z.string().max(80)).max(40).optional(),
  exclusions: z.array(z.string().max(80)).max(40).optional(),
});

export type ParsedQuery = z.infer<typeof parsedQuerySchema>;
