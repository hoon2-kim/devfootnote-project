import { ApiProperty } from '@nestjs/swagger';
import type {
  MaterialDetail,
  MaterialPage,
  MaterialSummary,
} from '../../../application/materials.types.js';
import { PaginationResponseDto } from '../../../../../common/dto/pagination.dto.js';

export class CreatedMaterialDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
}

export class MaterialSummaryDto extends CreatedMaterialDto {
  @ApiProperty() revision!: number;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  static from(material: MaterialSummary): MaterialSummaryDto {
    return {
      id: material.id,
      revisionId: material.revisionId,
      revision: material.revision,
      title: material.title,
      createdAt: material.createdAt.toISOString(),
      updatedAt: material.updatedAt.toISOString(),
    };
  }
}

export class MaterialDetailDto extends MaterialSummaryDto {
  @ApiProperty() body!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true }) context!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceUrl!: string | null;

  static override from(material: MaterialDetail): MaterialDetailDto {
    return {
      ...MaterialSummaryDto.from(material),
      body: material.body,
      note: material.note,
      context: material.context,
      sourceUrl: material.sourceUrl,
    };
  }
}

export class MaterialListDto extends PaginationResponseDto {
  @ApiProperty({ type: [MaterialSummaryDto] }) items!: MaterialSummaryDto[];
  @ApiProperty({ minimum: 1, maximum: 50 }) pageSize!: number;
  @ApiProperty({ minimum: 0, description: '현재 계정의 미삭제 자료 전체 개수' })
  totalCount!: number;

  static from(result: MaterialPage): MaterialListDto {
    return {
      items: result.items.map(MaterialSummaryDto.from),
      page: result.page,
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      hasNext: result.hasNext,
    };
  }
}
