import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Lyrics } from './entities/lyrics.entity';
import { CreateLyricsDto } from './dto/create-lyrics.dto';
import { UpdateLyricsDto } from './dto/update-lyrics.dto';
import { User } from '../users/entities/user.entity';
import { cacheConfig } from '../config/cache.config';
import { Genre } from './entities/genre.enum';
import { MAX_PAGE_SIZE } from '../common/dto/pagination-query.dto';
import { normalizeDecade } from '../game/progression.util';

/**
 * Maximum length of a lyric snippet served to players. Full lyric text is
 * never exposed; only a short snippet plus answer metadata is returned.
 */
export const MAX_LYRIC_SNIPPET_LENGTH = 150;

export interface LyricsCacheStats {
  keys: number;
  keysByType: {
    lyrics: number;
    random: number;
    category: number;
    search: number;
  };
  ttlMs: number;
}

@Injectable()
export class LyricsService {
  private readonly cacheTtlMs: number;

  /**
   * Every lyrics cache key this service has written, with its expiry time.
   * cache-manager has no prefix delete, so invalidation deletes these keys.
   * The global store is in-memory and per-process, which this matches;
   * moving to Redis (issue #115) would replace this with a prefix scan.
   */
  private readonly cachedKeys = new Map<string, number>();

  /**
   * Bumped on every invalidation. A read that started before a write must not
   * repopulate the cache with the data it loaded before that write.
   */
  private cacheGeneration = 0;

  constructor(
    @InjectRepository(Lyrics)
    private readonly lyricsRepository: Repository<Lyrics>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {
    this.cacheTtlMs = cacheConfig.lyricsTtlMs;
  }

  /**
   * Reject snippets that exceed the content policy limit. Full lyric text is
   * never served to players, so the snippet is the only lyric surface and it
   * must stay short.
   */
  private assertSnippetWithinLimit(snippet: string): void {
    if (snippet.length > MAX_LYRIC_SNIPPET_LENGTH) {
      throw new BadRequestException(
        `lyricSnippet must be at most ${MAX_LYRIC_SNIPPET_LENGTH} characters`,
      );
    }
  }

  async create(createLyricsDto: CreateLyricsDto, user: User): Promise<Lyrics> {
    // Derive lyricSnippet from content when the caller did not supply one.
    // The entity column is non-nullable so we must guarantee a value here.
    const lyricSnippet =
      createLyricsDto.lyricSnippet?.trim() ||
      (createLyricsDto.content ?? '').slice(0, MAX_LYRIC_SNIPPET_LENGTH).trim();

    this.assertSnippetWithinLimit(lyricSnippet);

    const lyrics = this.lyricsRepository.create({
      ...createLyricsDto,
      lyricSnippet,
      // Store decades in the canonical "1990s" format used by the seed and
      // the MusicDecade preference enum.
      decade: createLyricsDto.decade
        ? normalizeDecade(createLyricsDto.decade.toString())
        : createLyricsDto.decade,
      createdBy: user,
    });
    const savedLyrics = await this.lyricsRepository.save(lyrics);

    // Clear relevant caches when new lyrics are added
    await this.clearCache();

    return savedLyrics;
  }

  async findAll(
    genre?: string,
    decade?: number | string,
    limit: number = MAX_PAGE_SIZE,
    offset: number = 0,
  ): Promise<Lyrics[]> {
    const query = this.lyricsRepository
      .createQueryBuilder('lyrics')
      .leftJoinAndSelect('lyrics.createdBy', 'user');

    // Apply genre filter if provided
    if (genre) {
      // Validate genre against enum values
      const validGenres = Object.values(Genre);
      if (!validGenres.includes(genre as Genre)) {
        throw new BadRequestException(
          `Invalid genre. Valid genres are: ${validGenres.join(', ')}`,
        );
      }
      query.andWhere('lyrics.genre = :genre', { genre });
    }

    // Apply decade filter if provided. Accept both "1990" and "1990s" and
    // normalise to the stored "1990s" format before querying.
    if (decade !== undefined && decade !== null && decade !== '') {
      const decadeStr = normalizeDecade(decade.toString());
      if (!decadeStr) {
        throw new BadRequestException(
          'Invalid decade. Please provide a decade such as 1990 or 1990s',
        );
      }

      query.andWhere('lyrics.decade = :decade', { decade: decadeStr });
    }

    // Only return active lyrics
    query.andWhere('lyrics.isActive = :isActive', { isActive: true });

    // Always capped, so no caller can pull the whole table in one request
    const results = await query
      .orderBy('lyrics.id', 'ASC')
      .take(limit)
      .skip(offset)
      .getMany();

    // Return empty array instead of throwing exception for no results
    return results;
  }

  /**
   * Count lyrics, optionally filtered by active state. Used by the admin
   * listing to populate pagination metadata.
   */
  async count(isActive?: boolean): Promise<number> {
    if (isActive === undefined) {
      return this.lyricsRepository.count();
    }

    return this.lyricsRepository.count({ where: { isActive } });
  }

  async findOne(id: number): Promise<Lyrics> {
    // Validate ID
    if (!id || id <= 0) {
      throw new BadRequestException('Invalid lyrics ID');
    }

    const cacheKey = `${cacheConfig.keys.lyrics}${id}`;

    return this.getOrLoad(cacheKey, this.cacheTtlMs, async () => {
      const dbLyrics = await this.lyricsRepository.findOne({
        where: { id, isActive: true },
        relations: ['createdBy'],
      });

      if (!dbLyrics) {
        throw new NotFoundException('Lyrics not found');
      }

      return dbLyrics;
    });
  }

  /**
   * Load a lyric regardless of its active state. Admin-only: used by the
   * restore flow, which must be able to see soft-deleted (inactive) lyrics.
   * Bypasses the cache so a stale active-only entry cannot mask the row.
   */
  async findOneIncludingInactive(id: number): Promise<Lyrics> {
    if (!id || id <= 0) {
      throw new BadRequestException('Invalid lyrics ID');
    }

    const dbLyrics = await this.lyricsRepository.findOne({
      where: { id },
      relations: ['createdBy'],
    });

    if (!dbLyrics) {
      throw new NotFoundException('Lyrics not found');
    }

    return dbLyrics;
  }

  /**
   * Restore a soft-deleted lyric by setting isActive back to true. Throws
   * ConflictException when the lyric is already active.
   */
  async restore(id: number): Promise<Lyrics> {
    const lyrics = await this.findOneIncludingInactive(id);

    if (lyrics.isActive) {
      throw new ConflictException('Lyrics is already active');
    }

    lyrics.isActive = true;
    const restored = await this.lyricsRepository.save(lyrics);

    // The restored lyric must reappear in lists, categories, random and
    // search results, so drop every lyrics cache entry.
    await this.clearCache();

    return restored;
  }

  async update(
    id: number, // Fixed: should be number, not string
    updateLyricsDto: UpdateLyricsDto,
    user: User,
  ): Promise<Lyrics> {
    // Validate ID
    if (!id || id <= 0) {
      throw new BadRequestException('Invalid lyrics ID');
    }

    const lyrics = await this.lyricsRepository.findOne({
      where: { id, isActive: true },
      relations: ['createdBy'],
    });

    if (!lyrics) {
      throw new NotFoundException('Lyrics not found');
    }

    // Optional: Check if user is admin or creator
    // if (lyrics.createdBy.id !== user.id && !user.isAdmin) {
    //   throw new ForbiddenException('You can only update your own lyrics');
    // }

    // Update lyrics with new data
    Object.assign(lyrics, updateLyricsDto);
    lyrics.updatedAt = new Date(); // Assuming you have updatedAt field

    if (

/* … truncated 1342 chars — edit only what you need near the top … */
