import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsInt,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { EmbeddingPreviewResult } from '../embedding-activation.types.js';

export class EmbeddingTargetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  materialId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  revisionId!: string;
}

export class EmbeddingPreviewQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  afterId?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 20;
}

export class ActivateEmbeddingsDto {
  @ApiPropertyOptional({
    default: false,
    description: '기존 자료와 이후 저장·수정한 본문을 자동으로 준비한다. 빈 targets로 켤 수 있다.',
  })
  @IsOptional()
  @IsBoolean()
  includeExisting?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: '실패한 현재 자료의 새 generation을 명시적으로 요청한다.',
  })
  @IsOptional()
  @IsBoolean()
  retryFailed?: boolean;
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  requestId!: string;

  @ApiProperty()
  @Matches(/^[a-f0-9]{64}$/)
  configFingerprint!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  policyVersion!: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedConsentEpoch!: number;

  @ApiProperty({ enum: [true], description: '설명된 정책과 전송 범위에 대한 명시적 동의' })
  @Equals(true)
  accepted!: boolean;

  @ApiProperty({ type: [EmbeddingTargetDto], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EmbeddingTargetDto)
  targets!: EmbeddingTargetDto[];
}

export class RevokeEmbeddingConsentDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedConsentEpoch!: number;
}

export class EmbeddingConsentDto {
  @ApiProperty()
  consentEpoch!: number;
}

export class EmbeddingPolicyDto {
  @ApiProperty()
  configFingerprint!: string;
  @ApiProperty()
  policyVersion!: string;
  @ApiProperty()
  provider!: string;
  @ApiProperty()
  retentionNotice!: string;
  @ApiProperty()
  currency!: string;
  @ApiProperty()
  unitScale!: number;
  @ApiProperty({
    description: '정수 비용 단위의 기간 한도. 사용자마다 늘어나지 않는 공유 예산이다.',
  })
  budgetLimit!: string;
}

export class EmbeddingPreviewItemDto extends EmbeddingTargetDto {
  @ApiProperty()
  chunkCount!: number;
}

export class EmbeddingStateDto extends EmbeddingTargetDto {
  @ApiProperty({ type: String, nullable: true })
  title!: string | null;
  @ApiProperty({
    enum: [
      'NOT_STARTED',
      'PENDING',
      'LEASED',
      'CALLING',
      'RETRY_WAIT',
      'PUBLISHED',
      'FINAL_FAILED',
      'OBSOLETE',
    ],
  })
  state!: string;
  @ApiProperty({ type: String, nullable: true })
  failure!: string | null;
}

export class EmbeddingPreviewDto extends EmbeddingConsentDto {
  @ApiProperty({ description: '현재 설정·동의에 유효한 자동 준비 활성화 여부' })
  automatic!: boolean;
  @ApiProperty({ description: '기존 자료까지 자동 준비하도록 명시적으로 활성화했는지 여부' })
  includeExisting!: boolean;
  @ApiProperty()
  consented!: boolean;
  @ApiProperty({ type: [EmbeddingStateDto] })
  states!: EmbeddingStateDto[];
  @ApiProperty()
  configured!: boolean;
  @ApiProperty({ type: EmbeddingPolicyDto, nullable: true })
  policy!: EmbeddingPolicyDto | null;
  @ApiProperty({ type: [EmbeddingPreviewItemDto] })
  items!: EmbeddingPreviewItemDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  nextCursor!: string | null;
  @ApiProperty()
  reservedMaximum!: string;

  static from(result: EmbeddingPreviewResult): EmbeddingPreviewDto {
    const policy = result.policy;

    // 예산 ID·실행 설정·intent ID는 내부 결과에만 두고 공개 계약의 필드만 선택한다.
    return {
      configured: result.configured,
      consentEpoch: result.consentEpoch,
      consented: result.consented,
      automatic: result.automatic,
      includeExisting: result.includeExisting,
      states: result.states,
      policy: policy
        ? {
            configFingerprint: policy.fingerprint,
            policyVersion: policy.policyVersion,
            provider: policy.provider,
            retentionNotice: policy.retentionNotice,
            currency: policy.currency,
            unitScale: policy.unitScale,
            budgetLimit: policy.purposeBudgetLimit ?? policy.budgetLimit,
          }
        : null,
      items: result.items.map((item) => ({
        materialId: item.materialId,
        revisionId: item.revisionId,
        chunkCount: item.chunkCount,
      })),
      nextCursor: result.nextCursor,
      reservedMaximum: result.reservedMaximum,
    };
  }
}

export class EmbeddingActivationDto extends EmbeddingConsentDto {
  @ApiProperty({ format: 'uuid' })
  requestId!: string;
  @ApiProperty({ type: [String] })
  workIds!: string[];
  @ApiProperty({ description: '예약한 최대 비용. 큐 claim이나 AI 처리 완료를 뜻하지 않는다.' })
  reservedMaximum!: string;
}
