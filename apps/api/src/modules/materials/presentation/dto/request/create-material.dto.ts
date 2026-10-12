import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  MaxLength,
  NotContains,
  ValidateIf,
} from 'class-validator';

export class CreateMaterialDto {
  @ApiProperty({ format: 'uuid', description: '재시도 시 같은 입력과 함께 유지하는 요청 ID' })
  @IsUUID('4')
  idempotencyKey!: string;

  @ApiProperty({ maxLength: 10000 })
  @IsString()
  @MaxLength(10000)
  @Matches(/\S/u)
  @NotContains('\0')
  body!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(200)
  @NotContains('\0')
  title?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  @NotContains('\0')
  note?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(1000)
  @NotContains('\0')
  context?: string;

  @ApiPropertyOptional({ maxLength: 2048, format: 'uri' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  @NotContains('\0')
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
    disallow_auth: true,
  })
  sourceUrl?: string;
}
