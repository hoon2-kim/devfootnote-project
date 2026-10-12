import { Body, Controller, Get, Header, HttpCode, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SearchService } from './search.service.js';
import type { AuthenticatedRequest } from '../auth/index.js';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator.js';
import { ApiErrorDto } from '../../common/dto/api-error.dto.js';
import {
  SearchQueryDto,
  SearchResponseDto,
  SemanticSearchDto,
  SemanticSearchResponseDto,
} from './dto/search.dto.js';

@Controller('search')
@ApiSecurity('access')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto })
@ApiBadRequestResponse({ type: ApiErrorDto })
@ApiInternalServerErrorResponse({ type: ApiErrorDto })
@ApiServiceUnavailableResponse({ type: ApiErrorDto })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post('semantic')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'searchSemanticMaterials' })
  @ApiEnvelope(SemanticSearchResponseDto)
  async semantic(
    @Req() req: AuthenticatedRequest,
    @Body() input: SemanticSearchDto,
  ): Promise<SemanticSearchResponseDto> {
    return SemanticSearchResponseDto.from(await this.search.semantic(req.user.ownerId, input));
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'searchMaterials' })
  @ApiEnvelope(SearchResponseDto)
  async find(
    @Req() req: AuthenticatedRequest,
    @Query() input: SearchQueryDto,
  ): Promise<SearchResponseDto> {
    const result = await this.search.search(req.user.ownerId, input.q, input.page, input.pageSize);

    return SearchResponseDto.from(result);
  }
}
