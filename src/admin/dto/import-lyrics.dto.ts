import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export type ImportLyricsMode = 'create-only' | 'upsert';

export class ImportLyricsDto {
  @ApiPropertyOptional({
    description: 'Whether to validate the import without persisting the changes.',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean | string;

  @ApiPropertyOptional({
    description:
      'Import mode: "create-only" skips rows whose (artist, songTitle) already exist, "upsert" updates them.',
    enum: ['create-only', 'upsert'],
    default: 'create-only',
  })
  @IsOptional()
  @IsIn(['create-only', 'upsert'])
  mode?: ImportLyricsMode;
}
