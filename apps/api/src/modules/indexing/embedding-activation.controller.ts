import { Body, Controller, Get, Header, HttpCode, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/index.js';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator.js';
import { ApiErrorDto } from '../../common/dto/api-error.dto.js';
import { EmbeddingActivationService } from './embedding-activation.service.js';
import {
  ActivateEmbeddingsDto,
  EmbeddingActivationDto,
  EmbeddingConsentDto,
  EmbeddingPreviewDto,
  EmbeddingPreviewQueryDto,
  RevokeEmbeddingConsentDto,
} from './dto/embedding-activation.dto.js';

@Controller('indexing/embedding')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto })
@ApiBadRequestResponse({ type: ApiErrorDto })
@ApiConflictResponse({ type: ApiErrorDto })
@ApiNotFoundResponse({ type: ApiErrorDto })
@ApiServiceUnavailableResponse({ type: ApiErrorDto })
@ApiInternalServerErrorResponse({ type: ApiErrorDto })
export class EmbeddingActivationController {
  constructor(private readonly activation: EmbeddingActivationService) {}

  @Get('preview')
  @Header('Cache-Control', 'no-store')
  @ApiSecurity('access')
  @ApiOperation({ operationId: 'previewEmbeddingActivation' })
  @ApiEnvelope(EmbeddingPreviewDto)
  async preview(
    @Req() req: AuthenticatedRequest,
    @Query() query: EmbeddingPreviewQueryDto,
  ): Promise<EmbeddingPreviewDto> {
    const result = await this.activation.preview(req.user.ownerId, query.afterId, query.limit);

    return EmbeddingPreviewDto.from(result);
  }

  @Post('activations')
  @HttpCode(202)
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'activateCurrentEmbeddings' })
  @ApiEnvelope(EmbeddingActivationDto, 202)
  async activate(
    @Req() req: AuthenticatedRequest,
    @Body() input: ActivateEmbeddingsDto,
  ): Promise<EmbeddingActivationDto> {
    const result = await this.activation.activate(req.user.ownerId, input);

    return {
      requestId: result.requestId,
      consentEpoch: result.consentEpoch,
      workIds: result.workIds,
      reservedMaximum: result.reservedMaximum,
    };
  }

  @Post('consent/revoke')
  @HttpCode(200)
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'revokeEmbeddingConsent' })
  @ApiEnvelope(EmbeddingConsentDto)
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Body() input: RevokeEmbeddingConsentDto,
  ): Promise<EmbeddingConsentDto> {
    const result = await this.activation.revoke(req.user.ownerId, input.expectedConsentEpoch);

    return { consentEpoch: result.consentEpoch };
  }
}
