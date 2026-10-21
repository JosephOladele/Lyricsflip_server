/**
 * Single source of truth for answer matching across every game mode
 * (solo play, rooms, daily challenge, WebSocket gateway).
 *
 * Replaces the previous three normalisers (`guess-matcher.ts`,
 * `answer-matching.util.ts` and `LyricsService.normalizeAnswer`).
 */

/** Maximum number of aliases accepted per lyric (artist or title). */
export const MAX_ALIASES = 20;

/** Points awarded for an exact match. */
export const EXACT_MATCH_POINTS = 100;

/** Points awarded for a non-exact (alias / normalised) match. */
export const PARTIAL_MATCH_POINTS = 50;

const LEADING_ARTICLES = /^(the|a|an)\s+/;

/**
 * Normalise an answer for comparison.
 *
 * - NFKD decomposition, then strip combining diacritics so `Beyoncé`,
 *   `Beyonce` and `BEYONCÉ` all collapse to `beyonce`.
 * - `&` becomes `and`.
 * - `feat.` / `ft.` (and their variants) are removed.
 * - Leading articles (`the`, `a`, `an`) are dropped.
 * - Punctuation is removed and whitespace collapsed.
 */
export function normalizeAnswer(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  let result = value
    .normalize('NFKD')
    // Strip combining diacritical marks (U+0300–U+036F).
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Remove "feat." / "ft." and everything that follows it.
    .replace(/\b(feat|ft|featuring)\b\.?.*$/g, ' ')
    // Replace any remaining non-alphanumeric characters with a space.
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  result = result.replace(LEADING_ARTICLES, '').trim();

  return result;
}

export interface MatchResult {
  isCorrect: boolean;
  isExact: boolean;
  points: number;
}

/**
 * Match a guess against the canonical answer and any accepted aliases.
 *
 * An exact match (guess equals the canonical answer after normalisation)
 * earns full points; a match against an alias earns partial points.
 */
export function matchAnswer(
  guess: string | null | undefined,
  canonical: string | null | undefined,
  aliases: string[] = [],
): MatchResult {
  const normalizedGuess = normalizeAnswer(guess);

  if (!normalizedGuess) {
    return { isCorrect: false, isExact: false, points: 0 };
  }

  const normalizedCanonical = normalizeAnswer(canonical);

  if (normalizedCanonical && normalizedGuess === normalizedCanonical) {
    return {
      isCorrect: true,
      isExact: true,
      points: EXACT_MATCH_POINTS,
    };
  }

  const aliasMatch = (aliases ?? []).some(
    (alias) => normalizeAnswer(alias) === normalizedGuess,
  );

  if (aliasMatch) {
    return {
      isCorrect: true,
      isExact: true,
      points: EXACT_MATCH_POINTS,
    };
  }

  return { isCorrect: false, isExact: false, points: 0 };
}
