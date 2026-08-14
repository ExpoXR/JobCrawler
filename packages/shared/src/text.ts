/**
 * Text normalisation shared by matching, deduplication and indexing.
 *
 * Europe-first (plan section 39): diacritics are folded, German umlauts get
 * their conventional transliteration, and the common legal-form suffixes of
 * several European jurisdictions are stripped from company names so that
 * "Müller Software GmbH & Co. KG" and "Mueller Software" collapse together.
 */

const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'oe',
  å: 'aa',
};

/** Lowercase, transliterate umlauts, strip remaining diacritics. */
export function foldText(input: string): string {
  const lowered = input.toLowerCase();
  const transliterated = lowered.replace(/[äöüßæøå]/g, (char) => UMLAUT_MAP[char] ?? char);
  return transliterated.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Canonical form used for lookups and comparisons. */
export function normalizeText(input: string): string {
  return normalizeWhitespace(foldText(input).replace(/[^a-z0-9+#./ -]/g, ' '));
}

export function slugify(input: string): string {
  return foldText(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

const LEGAL_SUFFIXES = [
  'gmbh & co. kg',
  'gmbh & co kg',
  'gmbh',
  'mbh',
  'ug (haftungsbeschraenkt)',
  'ug',
  'ag',
  'kg',
  'ohg',
  'gbr',
  'e.k.',
  'ek',
  'e.v.',
  'ev',
  'se',
  'ltd',
  'ltd.',
  'limited',
  'plc',
  'llc',
  'inc',
  'inc.',
  'corp',
  'corp.',
  'b.v.',
  'bv',
  'n.v.',
  'nv',
  's.a.',
  'sa',
  'sas',
  'sarl',
  's.r.l.',
  'srl',
  's.p.a.',
  'spa',
  'oy',
  'ab',
  'as',
  'a/s',
  'aps',
  'sp. z o.o.',
  'sp z oo',
  'd.o.o.',
  'kft',
  'zrt',
];

/** Company name reduced to its distinctive part, for dedup and lookups. */
export function normalizeCompanyName(input: string): string {
  let value = normalizeText(input).replace(/[.,]/g, ' ');
  value = normalizeWhitespace(value);

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const normalizedSuffix = normalizeWhitespace(normalizeText(suffix).replace(/[.,]/g, ' '));
      if (!normalizedSuffix) continue;
      if (value === normalizedSuffix) continue;
      if (value.endsWith(` ${normalizedSuffix}`)) {
        value = value.slice(0, -normalizedSuffix.length - 1).trim();
        changed = true;
      }
    }
    value = value.replace(/\s*&\s*$/, '').trim();
  }

  return value || normalizeText(input);
}

const TITLE_NOISE = new Set([
  'm',
  'w',
  'd',
  'f',
  'x',
  'mwd',
  'wmd',
  'fmx',
  'all',
  'genders',
  'gn',
  'divers',
  'in',
]);

/** Job title reduced to comparable form: gender markers and (m/w/d) removed. */
export function normalizeJobTitle(input: string): string {
  const withoutParens = input.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const normalized = normalizeText(withoutParens);
  const tokens = normalized
    .split(/[\s/*-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !TITLE_NOISE.has(token));
  return tokens.join(' ');
}

const STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'you',
  'our',
  'are',
  'und',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'fuer',
  'mit',
  'wir',
  'sie',
  'als',
  'von',
  'zur',
  'zum',
  'les',
  'des',
  'une',
  'pour',
]);

export function tokenize(input: string, { keepStopwords = false } = {}): string[] {
  return normalizeText(input)
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.replace(/^[.]+|[.]+$/g, ''))
    .filter((token) => token.length > 1 && (keepStopwords || !STOPWORDS.has(token)));
}

/** Jaccard similarity over token sets — cheap lexical overlap measure. */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${normalizeText(value)} `;
  const result = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) result.add(padded.slice(i, i + 3));
  return result;
}

/** Dice coefficient over character trigrams — tolerant of spelling drift. */
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;
  return (2 * intersection) / (setA.size + setB.size);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Strips control characters that have no business in stored scraped text. */
export function sanitizeScrapedText(input: string, maxLength = 20_000): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const cleaned = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return truncate(normalizeWhitespace(cleaned), maxLength);
}
