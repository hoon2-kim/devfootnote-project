import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MaterialIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() materialId!: string;
}
