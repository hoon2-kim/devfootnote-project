import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
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
import { MaterialsService } from '../application/materials.service.js';
import type { AuthenticatedRequest } from '../../auth/index.js';
import { ApiEnvelope } from '../../../common/decorators/api-envelope.decorator.js';
import { ApiErrorDto } from '../../../common/dto/api-error.dto.js';
import { CreateMaterialDto } from './dto/request/create-material.dto.js';
import { MaterialIdDto } from './dto/request/material-query.dto.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { DeleteMaterialDto, UpdateMaterialDto } from './dto/request/change-material.dto.js';
import {
  CreatedMaterialDto,
  MaterialDetailDto,
  MaterialListDto,
} from './dto/response/material-response.dto.js';

@Controller('materials')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto })
@ApiBadRequestResponse({ type: ApiErrorDto })
@ApiInternalServerErrorResponse({ type: ApiErrorDto })
@ApiServiceUnavailableResponse({ type: ApiErrorDto })
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Post()
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'createMaterial' })
  @ApiEnvelope(CreatedMaterialDto, 201)
  @ApiConflictResponse({ type: ApiErrorDto })
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() input: CreateMaterialDto,
  ): Promise<CreatedMaterialDto> {
    const result = await this.materials.create(req.user.ownerId, input);

    return { id: result.id, revisionId: result.revisionId };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiSecurity('access')
  @ApiOperation({ operationId: 'listMaterials' })
  @ApiEnvelope(MaterialListDto)
  async list(
    @Req() req: AuthenticatedRequest,
    @Query() query: PaginationQueryDto,
  ): Promise<MaterialListDto> {
    const result = await this.materials.list(req.user.ownerId, query.page, query.pageSize);

    return MaterialListDto.from(result);
  }

  @Put(':materialId')
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'updateMaterial' })
  @ApiEnvelope(CreatedMaterialDto)
  @ApiConflictResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async update(
    @Req() req: AuthenticatedRequest,
    @Param() params: MaterialIdDto,
    @Body() input: UpdateMaterialDto,
  ): Promise<CreatedMaterialDto> {
    const result = await this.materials.update(req.user.ownerId, params.materialId, input);

    return { id: result.id, revisionId: result.revisionId };
  }

  @Delete(':materialId')
  @HttpCode(200)
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'deleteMaterial' })
  @ApiEnvelope(CreatedMaterialDto)
  @ApiConflictResponse({ type: ApiErrorDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async delete(
    @Req() req: AuthenticatedRequest,
    @Param() params: MaterialIdDto,
    @Body() input: DeleteMaterialDto,
  ): Promise<CreatedMaterialDto> {
    const result = await this.materials.delete(req.user.ownerId, params.materialId, input);

    return { id: result.id, revisionId: result.revisionId };
  }

  @Get(':materialId')
  @Header('Cache-Control', 'no-store')
  @ApiSecurity('access')
  @ApiOperation({ operationId: 'getMaterial' })
  @ApiEnvelope(MaterialDetailDto)
  @ApiNotFoundResponse({ type: ApiErrorDto })
  async read(
    @Req() req: AuthenticatedRequest,
    @Param() params: MaterialIdDto,
  ): Promise<MaterialDetailDto> {
    const result = await this.materials.read(req.user.ownerId, params.materialId);

    return MaterialDetailDto.from(result);
  }
}
