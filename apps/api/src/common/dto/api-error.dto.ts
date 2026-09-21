import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class ValidationIssueDto {
  @ApiProperty() field!: string;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}

export class ApiErrorDto {
  @ApiProperty({ enum: [false] }) success!: false;
  @ApiProperty() error!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: [ValidationIssueDto] }) errors?: ValidationIssueDto[];
}
