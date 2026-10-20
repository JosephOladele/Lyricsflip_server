import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export const LEADERBOARD_SORTS = ['xp', 'level', 'username'] as const;
export const SORT_ORDERS = ['ASC', 'DESC'] as const;
export const LEADERBOARD_PERIODS = ['all', 'weekly', 'monthly'] as const;

export class LeaderboardQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: LEADERBOARD_SORTS, default: 'xp' })
  @IsOptional()
  @IsIn(LEADERBOARD_SORTS)
  sort?: (typeof LEADERBOARD_SORTS)[number];

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'DESC' })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order?: (typeof SORT_ORDERS)[number];

  @ApiPropertyOptional({ enum: LEADERBOARD_PERIODS, default: 'all' })
  @IsOptional()
  @IsIn(LEADERBOARD_PERIODS)
  period?: (typeof LEADERBOARD_PERIODS)[number];

  @ApiPropertyOptional({ description: 'Filter rankings by lyric genre' })
  @IsOptional()
  @IsString()
  genre?: string;

  @ApiPropertyOptional({ description: 'Include admin users (admin only)', default: false })
  @IsOptional()
  @IsBooleanString()
  includeAdmins?: string;
}
