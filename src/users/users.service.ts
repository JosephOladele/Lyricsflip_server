import {
  Injectable,
  BadRequestException,
  ConflictException,
  Inject,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserPreferencesDto } from './dto/update-user-preferences.dto';
import { User } from './entities/user.entity';
import { Cache } from 'cache-manager';
import { Wager, WagerStatus } from '../tokens/entities/wager.entity';

// Wager states that have not yet reached a final outcome. A user involved in
// any wager in one of these states cannot be deleted/deactivated, since doing
// so could leave a wager unresolvable or an escrowed stake unaccounted for.
const NON_TERMINAL_WAGER_STATUSES = [
  WagerStatus.PENDING,
  WagerStatus.AWAITING_STAKES,
  WagerStatus.STAKED,
  WagerStatus.SETTLING,
];
import { AdminUpdateUserDto, UpdateProfileDto } from './dto/update-user.dto';
import { MAX_PAGE_SIZE } from '../common/dto/pagination-query.dto';
import { cacheConfig } from '../config/cache.config';

// Fields that are safe to expose on a public player profile. Everything else
// on the User entity (email, wallet address, preferences, flags, timestamps)
// is considered private and must never leak through the public endpoint.
const PUBLIC_PROFILE_FIELDS = [
  'username',
  'level',
  'levelTitle',
  'xp',
  'achievements',
  'wins',
  'losses',
] as const;
// Usernames must be 3-30 chars, start with a letter, and contain only
// letters, numbers and underscores (issue #129).
const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,29}$/;
export type LeaderboardPeriod = 'weekly' | 'monthly' | 'all';

const LEADERBOARD_PERIODS: LeaderboardPeriod[] = ['weekly', 'monthly', 'all'];

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Wager)
    private readonly wagerRepository: Repository<Wager>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(limit: number = 20, offset: number = 0) {
    return this.userRepository.find({
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
  }

  async count(): Promise<number> {
    return this.userRepository.count();
  }

  async findOne(id: string) {
    const user = await this.userRepository.findOne({
      where: { id },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }

  /**
   * Returns the deliberately public view of a player profile, looked up by
   * username. Only fields listed in PUBLIC_PROFILE_FIELDS are exposed; the
   * full entity (email, wallet, preferences, etc.) is never returned here.
   */
  async findPublicProfile(username: string) {
    const user = await this.userRepository.findOne({
      where: { username },
      select: [...PUBLIC_PROFILE_FIELDS],
    });
    if (!user) {
      throw new NotFoundException(`User with username ${username} not found`);
    }

    const wins = user.wins ?? 0;
    const losses = user.losses ?? 0;
    const totalGames = wins + losses;
    const winRate = totalGames > 0 ? wins / totalGames : 0;

    return {
      username: user.username,
      level: user.level,
      levelTitle: user.levelTitle,
      xp: user.xp,
      achievements: user.achievements ?? [],
      winRate,
    };
  }

  /**
   * Alias used by the controller for the public profile lookup.
   */
  async findByUsername(username: string) {
    return this.findPublicProfile(username);
  }

  /**
   * Returns the richer self-service profile for the authenticated user:
   * the user record, its level title, the linked wallet, a balance summary
   * and gameplay stats.
   */
  async getProfile(userId: string) {
    const user = await this.findOne(userId);

    const balance = user.balance ?? 0;
    const stats = {
      xp: user.xp ?? 0,
      level: user.level ?? 1,
      totalWins: user.totalWins ?? 0,
      totalLosses: user.totalLosses ?? 0,
      totalWagers: user.totalWagers ?? 0,
    };

    return {
      ...user,
      levelTitle: this.getLevelTitle(stats.level),
      wallet: user.stellarAddress
        ? {
            address: user.stellarAddress,
            verified: Boolean(user.stellarAddressVerifiedAt),
          }
        : null,
      balance: {
        amount: balance,
        currency: 'XLM',
      },
      stats,
    };
  }

  /**
   * Alias used by the controller for the authenticated user's profile.
   */
  async getSelfProfile(userId: string) {
    return this.getProfile(userId);
  }

  /**
   * Self-service profile update for the authenticated user. Validates the
   * username format and enforces uniqueness before persisting.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.findOne(userId);

    if (dto.username && dto.username !== user.username) {
      if (!USERNAME_PATTERN.test(dto.username)) {
        throw new BadRequestException(
          'Username must be 3-30 characters, start with a letter, and contain only letters, numbers and underscores',
        );
      }
      await this.assertUnused(
        { username: dto.username },
        userId,
        'Username already exists',
      );
    }

    Object.assign(user, dto);
    await this.userRepository.save(user);
    await this.cacheManager.del(`user:${userId}`);

    return this.getProfile(userId);
  }

  private getLevelTitle(level: number): string {
    if (level >= 50) return 'Legend';
    if (level >= 30) return 'Master';
    if (level >= 20) return 'Expert';
    if (level >= 10) return 'Veteran';
    if (level >= 5) return 'Apprentice';
    return 'Rookie';
  }

  async update(id: string, updateUserDto: UpdateProfileDto | AdminUpdateUserDto) {
    const user = await this.findOne(id);

    // Report taken usernames/emails as 409 rather than a unique-index 500
    const { username } = updateUserDto;
    const email = 'email' in updateUserDto ? updateUserDto.email : undefined;
    if (username && username !== user.username) {
      await this.assertUnused({ username }, id, 'Username already exists');
    }
    if (email && email !== user.email) {
      await this.assertUnused({ email }, id, 'Email already exists');
    }

    Object.assign(user, updateUserDto);
    return this.userRepository.save(user);
  }

  /**
   * Soft-deletes a user: deactivates and anonymizes the account instead of
   * removing the row. A hard delete would cascade into the user's lyric
   * catalogue, game history and wagers (or fail outright on FK constraints),
   * so the account is deactivated and its identifying fields scrubbed while
   * every row that references the user id is preserved.
   */
  private async assertUnused(
    where: { username: string } | { email: string },
    ownId: string,
    message: string,
  ): Promise<void> {
    const taken = await this.userRepository.exists({
      where: { ...where, id: Not(ownId) },
    });
    if (taken) {
      throw new ConflictException(message);
    }
  }

  async remove(id: string) {
    const user = await this.findOne(id);

    const activeWager = await this.wagerRepository.findOne({
      where: [
        { playerAId: id, status: In(NON_TERMINAL_WAGER_STATUSES) },
        { playerBId: id, status: In(NON_TERMINAL_WAGER_STATUSES) },
      ],
    });
    if (activeWager) {
      throw new ConflictException(
        'User has an in-progress wager and cannot be deleted until it is resolved',
      );
    }

    user.isActive = false;
    user.email = `deleted-${user.id}@deleted.lyricsflip.local`;
    user.username = `deleted_${user.id}`;
    user.name = null;
    user.stellarAddress = null;
    user.stellarAddressVerifiedAt = null;

    await this.userRepository.save(user);
    return { message: 'User deactivated successfully' };
  }

  /**
   * Leaderboard page. Ranks are computed with competition ranking
   * (`RANK() OVER (ORDER BY xp DESC)`) so tied users share the same rank,
   * matching the rank reported by `getMyRank`.
   */
  async getLeaderboard(
    limit: number = 20,
    offset: number = 0,
    period: LeaderboardPeriod = 'all',
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
    const safeOffset = Math.max(offset, 0);

    const rows = await this.userRepository.query(
      `SELECT id, username, xp, level, level_title AS "levelTitle",
              RANK() OVER (ORDER BY xp DESC) AS rank
         FROM users
        ORDER BY xp DESC, id ASC
        LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset],
    );

    return rows.map((row: any) => ({
      ...row,
      rank: Number(row.rank),
    }));
  }

  /**
   * Rank of a single user, using the same competition ranking as the
   * leaderboard page so tied users see the same rank in both places.
   */
  async getMyRank(userId: string) {
    const rows = await this.userRepository.query(
      `SELECT rank FROM (
         SELECT id, RANK() OVER (ORDER BY xp DESC) AS rank
           FROM users
       ) ranked
       WHERE id = $1`,
      [userId],
    );

    if (!rows.length) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return { rank: Number(rows[0].rank) };
  }
}
