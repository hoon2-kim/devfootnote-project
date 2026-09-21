import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { CreateMaterialDto } from './create-material.dto.js';

export class UpdateMaterialDto extends CreateMaterialDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  expectedRevisionId!: string;
}

export class DeleteMaterialDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  idempotencyKey!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  expectedRevisionId!: string;
}
