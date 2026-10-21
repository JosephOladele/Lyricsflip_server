/**
 * Canonical game constants.
 *
 * XP / level product decision (issue #317):
 * There is exactly ONE level curve and ONE title list for the whole server.
 * The curve is threshold-based and capped at the final level:
 *
 *   Level 1 — Gossip Rookie   —    0 XP
 *   Level 2 — Gossip Novice   —  100 XP
 *   Level 3 — Gossip Insider  —  300 XP
 *   Level 4 — Gossip Expert   —  600 XP
 *   Level 5 — Gossip Guru     — 1000 XP
 *
 * XP is awarded at a single rate: 10 XP per correct guess.
 * `XpLevelService` is the only implementation of this curve; do not add
 * competing formulas elsewhere.
 */

export interface LevelThreshold {
  level: number;
  minXp: number;
  title: string;
}

export const XP_PER_CORRECT_GUESS = 10;

export const LEVEL_THRESHOLDS: readonly LevelThreshold[] = [
  { level: 1, minXp: 0, title: 'Gossip Rookie' },
  { level: 2, minXp: 100, title: 'Gossip Novice' },
  { level: 3, minXp: 300, title: 'Gossip Insider' },
  { level: 4, minXp: 600, title: 'Gossip Expert' },
  { level: 5, minXp: 1000, title: 'Gossip Guru' },
] as const;

export const MAX_LEVEL = LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1].level;
