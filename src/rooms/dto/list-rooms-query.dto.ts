import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListRoomsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['lobby'])
  status?: 'lobby';
}
