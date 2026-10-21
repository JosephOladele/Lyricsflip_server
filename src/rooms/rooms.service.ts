import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThanOrEqual, Repository, In } from 'typeorm';
import { Room, RoomStatus } from './entities/room.entity';
import { RoomUser } from './entities/room-user.entity';
import { Lyrics } from '../lyrics/entities/lyrics.entity';
import { CreateRoomDto } from './dto/create-room.dto';
import { GuessLyricDto } from './dto/guess-lyric.dto';
import { GuessType } from '../game/dto/guess.dto';
import { matchGuess } from '../game/guess-matcher';
import * as crypto from 'crypto';
import { JobLockService } from '../tokens/services/job-lock.service';

/** Default and hard cap for the number of players allowed in a room. */
export const DEFAULT_MAX_PLAYERS = 8;
export const MAX_PLAYERS_LIMIT = 50;

/** Lyric fields that are safe to show before a player has guessed. */
export interface RoomLyricView {
  id: number;
  lyricSnippet: string;
  category?: string;
  genre?: string;
  decade?: string;
  // Only present once the requesting player has guessed.
  artist?: string;
  songTitle?: string;
}

/** Public summary of a player. Never carries other User fields. */
export interface RoomPlayerView {
  id: string;
  username: string | null;
  hasGuessed: boolean;
  score: number;
}

export interface RoomStatusView {
  id: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  isClosed: boolean;
  hostId: string | null;
  maxPlayers: number;
  status: RoomStatus;
  startedAt: Date | null;
  roundCount: number;
  lyric: RoomLyricView;
  players: RoomPlayerView[];
}

export interface RoomGuessResult {
  roomId: string;
  guessType: GuessType;
  guess: string;
  isCorrect: boolean;
  score: number;
  correctAnswer: string;
  lyric: RoomLyricView;
}

/** A single ranked entry in the final room results. */
export interface RoomResultEntry {
  rank: number;
  userId: string;
  username: string | null;
  score: number;
  hasGuessed: boolean;
}

export interface RoomResultsView {
  roomId: string;
  status: RoomStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  roundCount: number;
  ranking: RoomResultEntry[];
}

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(
    @InjectRepository(Room)
    private roomRepository: Repository<Room>,
    @InjectRepository(RoomUser)
    private roomUserRepository: Repository<RoomUser>,
    @InjectRepository(Lyrics)
    private lyricsRepository: Repository<Lyrics>,
    private readonly jobLock: JobLockService,
  ) {}

  async create(createRoomDto: CreateRoomDto, hostId?: string) {
    let lyric: Lyrics;

    if (createRoomDto.lyricId) {
      const foundLyric = await this.lyricsRepository.findOne({
        where: { id: createRoomDto.lyricId, isActive: true },
      });
      if (!foundLyric) {
        throw new NotFoundException('Lyric not found');
      }
      lyric = foundLyric;
    } else {
      // Get a random lyric using a random-key technique instead of
      // ORDER BY RANDOM(), which forces Postgres to read and sort every row.
      const foundLyric = await this.pickRandomLyric();
      if (!foundLyric) {
        throw new NotFoundException('No lyrics available');
      }
      lyric = foundLyric;
    }

    // Generate a unique 6-character code
    const code = this.generateRoomCode();

    const maxPlayers = this.normalizeMaxPlayers(createRoomDto.maxPlayers);

    const room = this.roomRepository.create({
      name: createRoomDto.name,
      code,
      lyric,
      lyricId: lyric.id,
      hostId: hostId ?? null,
      maxPlayers,
      status: RoomStatus.LOBBY,
      startedAt: null,
      roundCount: 0,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
    } as Room);

    return this.roomRepository.save(room);
  }

  /**
   * Pick a random active lyric without a full-table sort.
   *
   * Uses random ID ranges with a retry: pick a random id in [minId, maxId],
   * then fetch the first active lyric at or after it. This is O(log n) with
   * the primary-key index instead of ORDER BY RANDOM()'s O(n log n).
   */
  private async pickRandomLyric(): Promise<Lyrics | null> {
    const bounds = await this.lyricsRepository
      .createQueryBuilder('lyrics')
      .select('MIN(lyrics.id)', 'min')
      .addSelect('MAX(lyrics.id)', 'max')
      .where('lyrics.isActive = :isActive', { isActive: true })
      .getRawOne<{ min: string | null; max: string | null }>();

    const min = bounds?.min ? Number(bounds.min) : null;
    const max = bounds?.max ? Number(bounds.max) : null;
    if (min === null || max === null) {
      return null;
    }

    const attempts = 5;
    for (let i = 0; i < attempts; i++) {
      const randomId = min + Math.floor(Math.random() * (max - min + 1));
      const lyric = await this.lyricsRepository
        .createQueryBuilder('lyrics')
        .where('lyrics.isActive = :isActive', { isActive: true })
        .andWhere('lyrics.id >= :randomId', { randomId })
        .orderBy('lyrics.id', 'ASC')
        .getOne();
      if (lyric) {
        return lyric;
      }
    }

    // Fallback: wrap around to the lowest active lyric.
    return this.lyricsRepository
      .createQueryBuilder('lyrics')
      .where('lyrics.isActive = :isActive', { isActive: true })
      .orderBy('lyrics.id', 'ASC')
      .getOne();
   * Clamp the requested player cap into the allowed range.
   */
  private normalizeMaxPlayers(requested?: number): number {
    if (requested === undefined || requested === null) {
      return DEFAULT_MAX_PLAYERS;
    }
    if (!Number.isInteger(requested) || requested < 1) {
      throw new BadRequestException('maxPlayers must be a positive integer');
    }
    return Math.min(requested, MAX_PLAYERS_LIMIT);
  }

  /**
   * Generates a unique 6-character alphanumeric code.
   * Uses base36 encoding of random bytes for a short, URL-friendly code.
   */
  private generateRoomCode(): string {
    // 3 bytes = 24 bits = up to ~16M combinations, encoded in base36 gives ~5 chars
    // We'll use 4 bytes and take first 6 chars to be safe
    const bytes = crypto.randomBytes(4);
    // Convert to base36 (0-9, a-z) and ensure 6 characters
    let code = bytes.toString('base64')
      .replace(/[+/=]/g, '') // Remove base64 special chars
      .toLowerCase()
      .substring(0, 6);
    
    // If somehow shorter, pad with random chars
    while (code.length < 6) {
      code += Math.floor(Math.random() * 36).toString(36);
    }
    return code.substring(0, 6);
  }

  async join(roomId: string, userId: string) {
    const room = await this.roomRepository.findOne({
      where: { id: roomId },
      relations: ['roomUsers', 'lyric'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    this.assertPlayable(room);

    // Check if user already joined
    const existingRoomUser = await this.roomUserRepository.findOne({
      where: { roomId, userId },
    });

    if (existingRoomUser) {
      throw new ConflictException('User already joined this room');
    }

    return this.addPlayer(room, userId);
  }

  /**
   * Join a room using its short 6-character code instead of UUID.
   */
  async joinByCode(code: string, userId: string) {
    const room = await this.roomRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['roomUsers', 'lyric'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    this.assertPlayable(room);

    // Check if user already joined
    const existingRoomUser = await this.roomUserRepository.findOne({
      where: { roomId: room.id, userId },
    });

    if (existingRoomUser) {
      throw new ConflictException('User already joined this room');
    }

    return this.addPlayer(room, userId);
  }

  /**
   * Atomically add a player to a room, enforcing the player cap.
   * The cap check and insert run inside a transaction with a row lock so
   * concurrent joins cannot exceed `maxPlayers`.
   */
  private async addPlayer(room: Room, userId: string): Promise<RoomUser> {
    return this.roomRepository.manager.transaction(async (manager) => {
      const lockedRoom = await manager.findOne(Room, {
        where: { id: room.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!lockedRoom) {
        throw new NotFoundException('Room not found');
      }

      const currentCount = await manager.count(RoomUser, {
        where: { roomId: room.id },
      });

      if (currentCount >= lockedRoom.maxPlayers) {
        throw new ConflictException('Room is full');
      }

      const roomUser = manager.create(RoomUser, {
        roomId: room.id,
        userId,
      });

      return manager.save(roomUser);
    });
  }

  /**
   * Host-only: start the room, issuing rounds to every member at once.
   * Uses the existing server-side round machinery (roundCount + answer
   * window) so all players see the same rounds.
   */
  async start(roomId: string, userId: string): Promise<RoomStatusView> {
    const room = await this.roomRepository.findOne({
      where: { id: roomId },
      relations: ['lyric', 'roomUsers', 'roomUsers.user'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.hostId !== userId) {
      throw new ForbiddenException('Only the host can start this room');
    }

    if (room.status !== RoomStatus.LOBBY) {
      throw new ConflictException('Room has already started');
    }

    this.assertPlayable(room);

    const roundCount = room.roundCount > 0 ? room.roundCount : 1;
    const startedAt = new Date();

    await this.roomRepository.update(room.id, {
      status: RoomStatus.IN_PROGRESS,
      startedAt,
      roundCount,
    });

    room.status = RoomStatus.IN_PROGRESS;
    room.startedAt = startedAt;
    room.roundCount = roundCount;

    return this.toStatusView(room, userId);
  }

  /**
   * Return the final ranking once the room is finished.
   */
  async getResults(roomId: string): Promise<RoomResultsView> {
    const room = await this.roomRepository.findOne({
      where: { id: roomId },
      relations: ['roomUsers', 'roomUsers.user'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.status !== RoomStatus.FINISHED) {
      throw new ConflictException('Room is not finished yet');
    }

    const ranking: RoomResultEntry[] = room.roomUsers
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((ru, index) => ({
        rank: index + 1,
        userId: ru.userId,
        username: ru.user?.username ?? null,
        score: ru.score,
        hasGuessed: ru.hasGuessed,
      }));

    return {
      roomId: room.id,
      status: room.status,
      startedAt: room.startedAt,
      finishedAt: room.finishedAt ?? null,
      roundCount: room.roundCount,
      ranking,
    };
  }

  /**
   * Get a paginated list of open (lobby) rooms.
   * Only returns rooms that are not closed and not expired.
   */
  async findOpenRooms(
    limit: number = 20,
    offset: number = 0,
  ): Promise<{ items: Room[]; total: number }> {
    const now = new Date();
    const qb = this.roomRepository
      .createQueryBuilder('room')
      .leftJoinAndSelect('room.lyric', 'lyric')
      .where('room.isClosed = :isClosed', { isClosed: false })
      .andWhere('(room.expiresAt IS NULL OR room.expiresAt > :now)', { now })
      .orderBy('room.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    const [items, total] = await qb.getManyAndCount();

    return { items, total };
  }

  async getRoomStatus(
    roomId: string,
    userId: string,
  ): Promise<RoomStatusView> {
    const room = await this.roomRepository.findOne({
      where: { id: roomId },
      relations: ['lyric', 'roomUsers', 'roomUsers.user'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    // Check if user has joined the room
    const roomUser = room.roomUsers.find((ru) => ru.userId === userId);
    if (!roomUser) {
      throw new NotFoundException('User has not joined this room');
    }

    return this.toStatusView(room, userId);
  }

  private toStatusView(room: Room, userId: string): RoomStatusView {
    const roomUser = room.roomUsers.find((ru) => ru.userId === userId);

    return {
      id: room.id,
      name: room.name,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      isClosed: room.isClosed,
      hostId: room.hostId ?? null,
      maxPlayers: room.maxPlayers,
      status: room.status,
      startedAt: room.startedAt ?? null,
      roundCount: room.roundCount,
      // The answers stay hidden until this player has guessed.
      lyric: this.toLyricView(room.lyric, roomUser?.hasGuessed ?? false),
      players: room.roomUsers.map((ru) => this.toPlayerView(ru)),
    };
  }

  async submitGuess(
    roomId: string,
    userId: string,
    guessDto: GuessLyricDto,
  ): Promise<RoomGuessResult> {
    const roomUser = await this.roomUserRepository.findOne({
      where: { roomId, userId },
      relations: ['room', 'room.lyric'],
    });

    if (!roomUser) {
      throw new NotFoundException('User has not joined this room');
    }

    if (roomUser.hasGuessed) {
      throw new ConflictException('User has already guessed in this room');
    }

    this.assertPlayable(roomUser.room);

    const lyric = roomUser.room.lyric;
    const guessType = guessDto.guessType ?? GuessType.SONG_TITLE;
    const target =
      guessType === GuessType.ARTIST ? lyric.artist : lyric.songTitle;

    const isCorrect = matchGuess(guessDto.guess, target);
    const score = isCorrect ? 100 : 0;

    roomUser.hasGuessed = true;
    roomUser.score = score;
    await this.roomUserRepository.save(roomUser);

    return {
      roomId,
      guessType,
      guess: guessDto.guess,
      isCorrect,
      score,
      correctAnswer: target,
      lyric: this.toLyricView(lyric, true),
    };
  }

  private toLyricView(lyric: Lyrics, reveal: boolean): RoomLyricView {
    const view: RoomLyricView = {
      id: lyric.id,
      lyricSnippet: lyric.lyricSnippet,
      category: lyric.category,
      genre: lyric.genre,
      decade: lyric.decade,
    };
    if (reveal) {
      view.artist = lyric.artist;
      view.songTitle = lyric.songTitle;
    }
    return view;
  }

  private toPlayerView(roomUser: RoomUser): RoomPlayerView {
    return {
      id: roomUser.userId,
      username: roomUser.user?.username ?? null,
      hasGuessed: roomUser.hasGuessed,
      score: roomUser.score,
    };
  }

  private assertPlayable(room: Room): void {
    if (room.isClosed) {
      throw new BadRequestException('Room is closed');
    }
    if (room.expiresAt && room.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Room has expired');
    }
  }

  /**
   * Close expired rooms on a schedule.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async closeExpiredRooms(): Promise<void> {
    const lockKey = 'rooms:close-expired';
    const acquired = await this.jobLock.acquire(lockKey, 60_000);
    if (!acquired) {
      return;
    }

    try {
      const now = new Date();
      const expired = await this.roomRepository.find({
        where: { isClosed: false, expiresAt: LessThanOrEqual(now) },
      });

      if (expired.length === 0) {
        return;
      }

      await this.roomRepository.update(
        { id: In(expired.map((r) => r.id)) },
        { isClosed: true },
      );

      this.logger.log(`Closed ${expired.length} expired room(s)`);
    } finally {
      await this.jobLock.release(lockKey);
    }
  }
}
