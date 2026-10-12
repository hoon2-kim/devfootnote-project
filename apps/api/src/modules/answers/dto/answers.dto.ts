import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  NotContains,
  ValidateNested,
} from 'class-validator';

export class AnswerEvidenceTargetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  materialId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  revisionId!: string;
}

export class AnswerHistoryTurnDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  requestId!: string;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  @NotContains('\0')
  question!: string;
}

export class GenerateAnswerDto {
  @ApiPropertyOptional({ type: [AnswerHistoryTurnDto], maxItems: 3 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => AnswerHistoryTurnDto)
  history?: AnswerHistoryTurnDto[];

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  requestId!: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @Matches(/\S/u)
  @NotContains('\0')
  question!: string;

  @ApiProperty({ type: [AnswerEvidenceTargetDto], minItems: 1, maxItems: 5 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AnswerEvidenceTargetDto)
  evidence!: AnswerEvidenceTargetDto[];
}

export class RevokeAnswerConsentDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedConsentEpoch!: number;
}

export class GrantAnswerConsentDto extends RevokeAnswerConsentDto {
  @ApiProperty()
  @Matches(/^[a-f0-9]{64}$/u)
  policyFingerprint!: string;

  @ApiProperty({ enum: [true] })
  @Equals(true)
  accepted!: boolean;
}

export class AnswerConsentDto {
  @ApiProperty()
  consentEpoch!: number;
}

export class AnswerPolicyDto {
  @ApiProperty()
  fingerprint!: string;
  @ApiProperty()
  provider!: string;
  @ApiProperty()
  model!: string;
  @ApiProperty()
  retentionNotice!: string;
  @ApiProperty()
  answerRetentionSeconds!: number;
  @ApiProperty()
  receiptRetentionDays!: number;
  @ApiProperty()
  budgetLimit!: string;
  @ApiProperty()
  currency!: string;
  @ApiProperty()
  unitScale!: number;
}

export class AnswerConfigurationDto extends AnswerConsentDto {
  @ApiProperty()
  configured!: boolean;
  @ApiProperty()
  consented!: boolean;
  @ApiProperty({ type: AnswerPolicyDto, nullable: true })
  policy!: AnswerPolicyDto | null;
}

export class AnswerClaimDto {
  @ApiProperty()
  text!: string;
  @ApiProperty({ type: [String] })
  evidenceIds!: string[];
}

export class AnswerCitationDto {
  @ApiProperty()
  evidenceId!: string;
  @ApiProperty({ format: 'uuid' })
  materialId!: string;
  @ApiProperty({ format: 'uuid' })
  revisionId!: string;
  @ApiProperty({ format: 'uuid' })
  chunkId!: string;
  @ApiProperty()
  startOffset!: number;
  @ApiProperty()
  endOffset!: number;
  @ApiProperty()
  href!: string;
}

export class AnswerResultDto {
  @ApiProperty({ format: 'uuid' })
  requestId!: string;
  @ApiProperty({
    enum: [
      'REQUESTED',
      'RESERVED',
      'RUNNING',
      'PUBLISHED',
      'NO_ANSWER',
      'FAILED',
      'EXPIRED',
      'INVALIDATED',
    ],
  })
  state!:
    | 'REQUESTED'
    | 'RESERVED'
    | 'RUNNING'
    | 'PUBLISHED'
    | 'NO_ANSWER'
    | 'FAILED'
    | 'EXPIRED'
    | 'INVALIDATED';
  @ApiProperty({ type: String, nullable: true })
  failure!: string | null;
  @ApiProperty({ type: [AnswerClaimDto] })
  claims!: AnswerClaimDto[];
  @ApiProperty({ type: [AnswerCitationDto] })
  citations!: AnswerCitationDto[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  answerExpiresAt!: string | null;
}
