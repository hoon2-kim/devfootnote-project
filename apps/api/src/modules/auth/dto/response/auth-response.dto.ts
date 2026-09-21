import { ApiProperty } from '@nestjs/swagger';

export class OwnerDto {
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
}
export class CsrfTokenDto {
  @ApiProperty() csrfToken!: string;
}
