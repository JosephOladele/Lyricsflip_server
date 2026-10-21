import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserLevel } from '../users/entities/user.entity';

export interface XpResult {
  /** Updated total XP. */
  xp: number;
  /** Numeric level (1–5). */
  level: number;
  /** Human-readable level title. */
  levelTitle: UserLevel;
  /** XP awarded by this call. */
  xpChange: number;
  /** True when the level changed as a result of this call. */
  leveledUp: boolean;
}

/**
 * Canonical XP curve and title list.
 *
 * This is the single source of truth for the level system. Ordered
 * thresholds — first match wins. Numeric `level` maps 1-to-1 to the
 * position in this array (index + 1).
 */
export const LEVEL_THRESHOLDS: ReadonlyArray<{
  min: number;
  max: number;
  level: number;
  levelTitle: UserLevel;
}> = [
  { min: 0,    max: 99,       level: 1, levelTitle: UserLevel.GOSSIP_ROOKIE  },
  { min: 100,  max: 299,      level: 2, levelTitle: UserLevel.WORD_WHISPERER },
  { min: 300,  max: 599,      level: 3, levelTitle: UserLevel.LYRIC_SNIPER   },
  { min: 600,  max: 999,      level: 4, levelTitle: UserLevel.BAR_GENIUS     },
  { min: 1000, max: Infinity, level: 5, levelTitle: UserLevel.GOSSIP_GURU    },
];

/** XP awarded per correct guess — the single XP-award constant. */
export const XP_PER_CORRECT_GUESS = 10;

/**
 * Pure: return the numeric level (1–5) and its human-readable title for a
 * given XP total.
 */
export function getLevelFromXp(xp: number): {
  level: number;
  levelTitle: UserLevel;
} {
  const threshold =
    LEVEL_THRESHOLDS.find((t) => xp >= t.min && xp <= t.max) ??
    LEVEL_THRESHOLDS[0];

  return { level: threshold.level, levelTitle: threshold.levelTitle };
}

/**
 * Pure: add XP for a number of correct guesses and return the updated totals.
 *
 * @param currentXp      - The user's current total XP.
 * @param correctGuesses - How many correct guesses to award (default 1).
 * @param xpPerGuess     - XP per correct guess (default XP_PER_CORRECT_GUESS).
 */
export function calculateXpGain(
  currentXp: number,
  correctGuesses = 1,
  xpPerGuess = XP_PER_CORRECT_GUESS,
): XpResult {
  const newXp = currentXp + correctGuesses * xpPerGuess;
  const { level, levelTitle } = getLevelFromXp(newXp);
  return { xp: newXp, level, levelTitle };
}

@Injectable()
export class XpLevelService {
  /**
   * Ordered thresholds — first match wins.
   * Numeric `level` maps 1-to-1 to the position in this array (index + 1).
   */
  private readonly LEVEL_THRESHOLDS: ReadonlyArray<{
    min: number;
    max: number;
    level: number;
    levelTitle: UserLevel;
  }> = [
    { min: 0,    max: 99,       level: 1, levelTitle: UserLevel.GOSSIP_ROOKIE  },
    { min: 100,  max: 299,      level: 2, levelTitle: UserLevel.WORD_WHISPERER },
    { min: 300,  max: 599,      level: 3, levelTitle: UserLevel.LYRIC_SNIPER   },
    { min: 600,  max: 999,      level: 4, levelTitle: UserLevel.BAR_GENIUS     },
    { min: 1000, max: Infinity, level: 5, levelTitle: UserLevel.GOSSIP_GURU    },
  ];

  /** Points-to-XP divisor for the single authoritative XP rule. */
  private readonly POINTS_PER_XP = 10;

  /** Bonus XP granted per consecutive correct guess in a streak. */
  private readonly STREAK_BONUS_XP = 2;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  // -------------------------------------------------------------------------
  // Pure helpers (no DB I/O — safe to call in unit tests without a repo)
  // -------------------------------------------------------------------------

  /** Return the numeric level (1–5) and its human-readable title for XP. */
  getLevelFromXp(xp: number): { level: number; levelTitle: UserLevel } {
    return getLevelFromXp(xp);
  }

  /**
   * Single authoritative XP rule for a scored guess.
   *
   * XP = floor(pointsAwarded / 10) plus a streak bonus for consecutive
   * correct guesses. Incorrect guesses award no XP.
   *
   * @param pointsAwarded - Points scored for the guess.
   * @param isCorrect     - Whether the guess was correct.
   * @param streak        - Current consecutive-correct streak (>= 1 when correct).
   */
  calculateXpForGuess(
    pointsAwarded: number,
    isCorrect: boolean,
    streak = 0,
  ): number {
    if (!isCorrect || pointsAwarded <= 0) {
      return 0;
    }
    const base = Math.floor(pointsAwarded / this.POINTS_PER_XP);
    const bonus = streak > 1 ? (streak - 1) * this.STREAK_BONUS_XP : 0;
    return base + bonus;
  }

  /**
   * Add XP for a number of correct guesses and return the updated totals.
   *
   * @param currentXp      - The user's current total XP.
   * @param correctGuesses - How many correct guesses to award (default 1).
   * @param xpPerGuess     - XP per correct guess (default 10).
   */
  /** Add XP for a number of correct guesses and return the updated totals. */
  calculateXpGain(
    currentXp: number,
    correctGuesses = 1,
    xpPerGuess = XP_PER_CORRECT_GUESS,
  ): XpResult {
    const xpChange = correctGuesses * xpPerGuess;
    const newXp = currentXp + xpChange;
    const { level, levelTitle } = this.getLevelFromXp(newXp);
    const previous = this.getLevelFromXp(currentXp);
    return {
      xp: newXp,
      level,
      levelTitle,
      xpChange,
      leveledUp: level !== previous.level,
    };
    return calculateXpGain(currentXp, correctGuesses, xpPerGuess);
  }

  // -------------------------------------------------------------------------
  // Stateful helper (persists to DB)
  // -------------------------------------------------------------------------

  /**
   * Award XP for a correct guess and persist the updated level and
   * levelTitle to the database.
   *
   * This is the single authoritative path for XP updates — call it from
   * any game controller or gateway that resolves a correct answer.
   *
   * The XP increment is performed atomically in the database so concurrent
   * awards are never lost, and only the `xp`, `level` and `levelTitle`
   * columns are touched — unrelated user columns are never overwritten.
   */
  async handleCorrectGuess(userId: string): Promise<XpResult> {
    // Atomically increment XP and read back the new total. This avoids the
    // read-modify-write race where two concurrent awards both read the same
    // starting XP and one award is lost.
    const rows: Array<{ xp: number; level: number }> =
      await this.userRepo.query(
        'UPDATE users SET xp = xp + $1 WHERE id = $2 RETURNING xp, level',
        [XP_PER_CORRECT_GUESS, userId],
      );

    const updated = rows[0];
    if (!updated) {
      // No matching user — surface the same error shape as findOneOrFail.
      await this.userRepo.findOneOrFail({ where: { id: userId } });
      throw new Error(`User ${userId} not found`);
    }

    const newXp = Number(updated.xp);
    const { level, levelTitle } = getLevelFromXp(newXp);

    // Only update the level columns when the level actually changed, and guard
    // with `level < $new` so a concurrent award that already advanced the level
    // cannot be regressed by a stale write.
    if (level > Number(updated.level)) {
      await this.userRepo.query(
        'UPDATE users SET level = $1, levelTitle = $2 WHERE id = $3 AND level < $1',
        [level, levelTitle, userId],
      );
    }

    return { xp: newXp, level, levelTitle };
  }

  /**
   * Award XP for a scored guess using the single authoritative XP rule and
   * persist the updated level/levelTitle. Returns the XP change and whether
   * the player leveled up so callers can emit `user.leveled_up`.
   *
   * @param userId        - The player's user id.
   * @param pointsAwarded - Points scored for the guess.
   * @param isCorrect     - Whether the guess was correct.
   * @param streak        - Current consecutive-correct streak.
   */
  async awardGuessXp(
    userId: string,
    pointsAwarded: number,
    isCorrect: boolean,
    streak = 0,
  ): Promise<XpResult> {
    const user = await this.userRepo.findOneOrFail({ where: { id: userId } });
    const xpChange = this.calculateXpForGuess(pointsAwarded, isCorrect, streak);
    const previous = this.getLevelFromXp(user.xp);
    const newXp = user.xp + xpChange;
    const { level, levelTitle } = this.getLevelFromXp(newXp);
    user.xp = newXp;
    user.level = level;
    user.levelTitle = levelTitle;
    await this.userRepo.save(user);
    return {
      xp: newXp,
      level,
      levelTitle,
      xpChange,
      leveledUp: level !== previous.level,
    };
  }
}
