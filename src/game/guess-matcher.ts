import { GAME_CONSTANTS } from './constants/game.constants';

export interface GuessMatch {
  isCorrect: boolean;
  isExactMatch: boolean;
  points: number;
}

// Articles and filler words that carry no identifying information. A guess
// made only of these can never be correct.
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'for',
  'with',
  'love',
]);

/**
 * Normalizes a string for comparison by removing punctuation,
 * extra whitespace, and converting to lowercase.
 */
export function normalizeAnswer(str: string): string {
  if (!str) return '';

  return (
    str
      .toLowerCase()
      .trim()
      // Remove common punctuation and special characters
      .replace(/[^\w\s]/g, '')
      // Replace multiple whitespaces with single space
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Splits a normalized string into meaningful tokens, dropping "feat."
 * segments and stop words.
 */
function tokenize(str: string): string[] {
  const withoutFeat = str.split(/\bfeat\b/)[0];
  return withoutFeat
    .split(' ')
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

/**
 * Jaccard similarity between two token sets: |intersection| / |union|.
 */
function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  setA.forEach((token) => {
    if (setB.has(token)) intersection += 1;
  });
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Dice similarity between two token sets: 2|intersection| / (|A| + |B|).
 */
function dice(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  setA.forEach((token) => {
    if (setB.has(token)) intersection += 1;
  });
  const total = setA.size + setB.size;
  return total === 0 ? 0 : (2 * intersection) / total;
}

/**
 * Levenshtein edit distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(cols).fill(0),
  );

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[a.length][b.length];
}

/**
 * Scores a guess against the correct answer (an artist or a song title).
 * Shared by solo play (GameLogicService) and rooms so both score identically.
 */
export function matchGuess(guess: string, answer: string): GuessMatch {
  const normalizedGuess = normalizeAnswer(guess);
  const normalizedAnswer = normalizeAnswer(answer);

  const isExactMatch =
    normalizedGuess.length > 0 && normalizedGuess === normalizedAnswer;

  const guessTokens = tokenize(normalizedGuess);
  const answerTokens = tokenize(normalizedAnswer);

  // A guess made only of stop words (e.g. "the", "love") is never correct.
  const hasMeaningfulGuess = guessTokens.length > 0;

  let isPartialMatch = false;
  if (!isExactMatch && hasMeaningfulGuess && answerTokens.length > 0) {
    const answerSet = new Set(answerTokens);
    const allAnswerTokensPresent = answerTokens.every((token) =>
      guessTokens.includes(token),
    );

    const similarity = Math.max(
      jaccard(guessTokens, answerTokens),
      dice(guessTokens, answerTokens),
    );

    const maxLen = Math.max(normalizedGuess.length, normalizedAnswer.length);
    const typoThreshold = Math.min(
      Math.floor(maxLen * GAME_CONSTANTS.VALIDATION.PARTIAL_MATCH_TYPO_RATIO),
      GAME_CONSTANTS.VALIDATION.PARTIAL_MATCH_MAX_TYPO_DISTANCE,
    );
    const withinTypoDistance =
      levenshtein(normalizedGuess, normalizedAnswer) <= typoThreshold;

    isPartialMatch =
      (allAnswerTokensPresent &&
        similarity >=
          GAME_CONSTANTS.VALIDATION.PARTIAL_MATCH_MIN_SIMILARITY) ||
      withinTypoDistance;
  }

  let points = 0;
  if (isExactMatch) {
    points = GAME_CONSTANTS.POINTS.CORRECT_GUESS;
  } else if (isPartialMatch) {
    points = GAME_CONSTANTS.POINTS.PARTIAL_MATCH;
  }

  return { isCorrect: isExactMatch || isPartialMatch, isExactMatch, points };
}
