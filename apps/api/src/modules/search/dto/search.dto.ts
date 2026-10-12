import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, MaxLength, NotContains } from 'class-validator';
import type {
  SearchItem,
  SearchMatchedField,
  SearchResult,
  SemanticMode,
  SemanticDegradedReason,
  SemanticSearchResult,
} from '../search.types.js';
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

export class SemanticSearchDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @NotContains('\0')
  q!: string;

  @ApiProperty({ enum: ['vector', 'hybrid'] })
  @IsIn(['vector', 'hybrid'])
  mode!: SemanticMode;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}

export class SemanticSearchResponseDto extends SearchResponseDto {
  @ApiProperty({ enum: ['vector', 'hybrid'] }) requestedMode!: SemanticMode;
  @ApiProperty({ enum: ['keyword', 'vector', 'hybrid'] }) effectiveMode!: SemanticMode | 'keyword';
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [
      'not_configured',
      'consent_required',
      'budget_exhausted',
      'request_used',
      'provider_unavailable',
      'consent_changed',
      'index_unavailable',
    ],
  })
  degradedReason!: SemanticDegradedReason | null;
  @ApiProperty({
    description: '의미검색은 상위 50개까지만 제공하며 후속 페이지는 호출하지 않습니다.',
  })
  resultLimit!: number;
  @ApiProperty({ description: '후보가 결과 상한을 넘으면 true입니다.' }) truncated!: boolean;

  static from(result: SemanticSearchResult): SemanticSearchResponseDto {
    return {
      ...SearchResponseDto.from(result),
      requestedMode: result.requestedMode,
      effectiveMode: result.effectiveMode,
      degradedReason: result.degradedReason,
      resultLimit: result.resultLimit,
      truncated: result.truncated,
    };
  }
}
