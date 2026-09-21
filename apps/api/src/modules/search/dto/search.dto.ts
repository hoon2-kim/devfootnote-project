import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, NotContains } from 'class-validator';
import type { SearchItem, SearchMatchedField, SearchResult } from '../search.types.js';
import { PaginationQueryDto, PaginationResponseDto } from '../../../common/dto/pagination.dto.js';

export class SearchQueryDto extends PaginationQueryDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @NotContains('\0')
  q!: string;
}

export class SearchItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() snippet!: string;
  @ApiProperty({ type: String, enum: ['body', 'note', 'context', 'title', 'sourceUrl'] })
  matchedField!: SearchMatchedField;

  static from(item: SearchItem): SearchItemDto {
    return {
      id: item.id,
      revisionId: item.revisionId,
      revision: item.revision,
      title: item.title,
      updatedAt: item.updatedAt.toISOString(),
      snippet: item.snippet,
      matchedField: item.matchedField,
    };
  }
}

export class SearchResponseDto extends PaginationResponseDto {
  @ApiProperty({ type: [SearchItemDto] }) items!: SearchItemDto[];

  static from(result: SearchResult): SearchResponseDto {
    return {
      items: result.items.map(SearchItemDto.from),
      page: result.page,
      hasNext: result.hasNext,
    };
  }
}
