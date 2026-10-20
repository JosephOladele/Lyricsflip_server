import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThanOrEqual, Repository, In } from 'typeorm';
import { Room } from './entities/room.entity';
import { RoomUser } from './entities/room-user.entity';
import { Lyrics } from '../lyrics/entities/lyrics.entity';
import { CreateRoomDto } from './dto/create-room.dto';
import { GuessLyricDto } from './dto/guess-lyric.dto';
import { GuessType } from '../game/dto/guess.dto';
import { matchGuess } from '../game/guess-matcher';
import * as crypto from 'crypto';
import { JobLockService } from '../tokens/services/job-lock.service';

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

/**
 * Unambiguous uppercase alphabet for room codes.
 * Excludes 0/O and 1/I to avoid confusion when codes are read aloud or typed.
 */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_MAX_ATTEMPTS = 5;

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

  async create(createRoomDto: CreateRoomDto) {
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
      // Get a random lyric
      const foundLyric = await this.lyricsRepository
        .createQueryBuilder('lyrics')
        .where('lyrics.isActive = :isActive', { isActive: true })
        .orderBy('RANDOM()')
        .getOne();
      if (!foundLyric) {
        throw new NotFoundException('No lyrics available');
      }
      lyric = foundLyric;
    }

    // Generate a unique 6-character code, retrying on unique violations.
    let lastError: unknown;
    for (let attempt = 0; attempt < ROOM_CODE_MAX_ATTEMPTS; attempt++) {
      const code = this.generateRoomCode();

      const room = this.roomRepository.create({
        name: createRoomDto.name,
        code,
        lyric,
        lyricId: lyric.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
      } as Room);

      try {
        return await this.roomRepository.save(room);
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          lastError = error;
          this.logger.warn(
            `Room code collision on attempt ${attempt + 1}, retrying`,
          );
          continue;
        }
        throw error;
      }
    }

    this.logger.error('Failed to generate a unique room code', lastError as Error);
    throw new ConflictException('Could not generate a unique room code');
  }

  /**
   * Generates a 6-character uppercase code from an unambiguous alphabet.
   * Uses crypto.randomInt for uniform, unbiased selection.
   */
  private generateRoomCode(): string {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[
        crypto.randomInt(0, ROOM_CODE_ALPHABET.length)
      ];
    }
    return code;
  }

  /** Detects a Postgres unique-constraint violation (SQLSTATE 23505). */
  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const err = error as { code?: string; driverError?: { code?: string } };
    return err.code === '23505' || err.driverError?.code === '23505';
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

    const roomUser = this.roomUserRepository.create({
      roomId,
      userId,
    });

    return this.roomUserRepository.save(roomUser);
  }

  /**
   * Join a room using its short 6-character code instead of UUID.
   * Codes are stored uppercase, so the input is uppercased before lookup.
   */
  async joinByCode(code: string, userId: string) {
    const room = await this.roomRepository.findOne({
      where: { code: code.trim().toUpperCase() },
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

    const roomUser = this.roomUserRepository.create({
      roomId: room.id,
      userId,
    });

    return this.roomUserRepository.save(roomUser);
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

    return {
      id: room.id,
      name: room.name,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      isClosed: room.isClosed,
      // The answers stay hidden until this player has guessed.
      lyric: this.toLyricView(room.lyric, roomUser.hasGuessed),
      players: room.roomUsers.map((ru) => this.toPlayerView(ru)),
    };
  }

  async submitGuess(
    roomId: string,
    userId: string,
    guessDto: GuessLyricDto,
  ): Promise<RoomGuessResult> {
    const room = await this.roomRepository.findOne({
      where: { id: roomId },
      relations: ['lyric'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    this.assertPlayable(room);

    const roomUser = await this.roomUserRepository.findOne({
      where: { roomId, userId },
    });

    if (!roomUser) {
      throw new NotFoundException('User has not joined this room');
    }

    // Atomically claim the guess. Only one concurrent request can flip
    // hasGuessed from false to true; the loser sees zero affected rows.
    const claim = await this.roomUserRepository
      .createQueryBuilder()
      .update(RoomUser)
      .set({ hasGuessed: true, guessedAt: () => 'now()' })
      .where('id = :id AND "hasGuessed" = false', { id: roomUser.id })
      .execute();

    if (!claim.affected || claim.affected !== 1) {
      // Already guessed (or lost the race). Do not reveal the answer.
      throw new ConflictException('You have already guessed in this room');
    }

    const lyric = room.lyric;
    const guessType = guessDto.guessType ?? GuessType.SONG_TITLE;
    const guess = guessDto.guess;

    const isCorrect = matchGuess(guess, lyric, guessType);
    const score = isCorrect ? this.calculateScore(lyric, guessType) : 0;

    // Persist the score now that the guess is claimed.
    await this.roomUserRepository.update(roomUser.id, { score });

    return {
      roomId: room.id,
      guessType,
      guess,
      isCorrect,
      score,
      correctAnswer: `${lyric.artist} - ${lyric.songTitle}`,
      lyric: this.toLyricView(lyric, true),
    };
  }

  private calculateScore(lyric: Lyrics, guessType: GuessType): number {
    // Base score per guess type; kept simple and deterministic.
    return guessType === GuessType.SONG_TITLE ? 100 : 50;
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

  @Cron(CronExpression.EVERY_HOUR)
  async closeExpiredRooms(): Promise<void> {
    const acquired = await this.jobLock.acquire('rooms:close-expired', 60_000);
    if (!acquired) {
      return;
    }
    try {
      await this.roomRepository.update(
        { isClosed: false, expiresAt: LessThanOrEqual(new Date()) },
        { isClosed: true },
      );
    } finally {
      await this.jobLock.release('rooms:close-expired');
    }
  }
}
