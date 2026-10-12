import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Sse,
  Injectable,
  BadRequestException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type MessageEvent,
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
  ApiTooManyRequestsResponse,
  ApiProduces,
  ApiOkResponse,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  catchError,
  concat,
  exhaustMap,
  map,
  of,
  take,
  takeWhile,
  throwError,
  timer,
  type Observable,
} from 'rxjs';
import type { AuthenticatedRequest } from '../auth/index.js';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator.js';
import { ApiErrorDto } from '../../common/dto/api-error.dto.js';
import { AnswersService } from './answers.service.js';
import {
  AnswerConfigurationDto,
  AnswerConsentDto,
  AnswerResultDto,
  GenerateAnswerDto,
  GrantAnswerConsentDto,
  RevokeAnswerConsentDto,
} from './dto/answers.dto.js';

type AnswerStreamRequest = AuthenticatedRequest & { answerSnapshot: AnswerResultDto };

// interceptor가 만든 Observable을 구독하기 전 SSE 헤더가 열릴 수 있다.
// 첫 owner 검사는 guard에서 끝내 잘못된 요청을 일반 HTTP 오류로 반환한다.
@Injectable()
class AnswerStreamGuard implements CanActivate {
  constructor(private readonly answers: AnswersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AnswerStreamRequest>();
    const requestId = await new ParseUUIDPipe().transform(req.params.requestId, {
      type: 'param',
      data: 'requestId',
      metatype: String,
    });

    if (typeof requestId !== 'string') {
      throw new BadRequestException();
    }

    req.answerSnapshot = await this.answers.read(req.user.ownerId, requestId);

    return true;
  }
}

@Controller('answers')
@ApiUnauthorizedResponse({ type: ApiErrorDto })
@ApiForbiddenResponse({ type: ApiErrorDto })
@ApiBadRequestResponse({ type: ApiErrorDto })
@ApiConflictResponse({ type: ApiErrorDto })
@ApiNotFoundResponse({ type: ApiErrorDto })
@ApiServiceUnavailableResponse({ type: ApiErrorDto })
@ApiInternalServerErrorResponse({ type: ApiErrorDto })
@ApiTooManyRequestsResponse({ type: ApiErrorDto })
export class AnswersController {
  constructor(private readonly answers: AnswersService) {}

  @Get('configuration')
  @Header('Cache-Control', 'no-store')
  @ApiSecurity('access')
  @ApiOperation({ operationId: 'getAnswerConfiguration' })
  @ApiEnvelope(AnswerConfigurationDto)
  async configuration(@Req() req: AuthenticatedRequest): Promise<AnswerConfigurationDto> {
    const result = await this.answers.configuration(req.user.ownerId);
    const policy = result.policy;

    return {
      configured: result.configured,
      consented: result.consented,
      consentEpoch: result.consentEpoch,
      policy: policy
        ? {
            fingerprint: policy.fingerprint,
            provider: policy.provider,
            model: policy.model,
            retentionNotice: policy.retentionNotice,
            answerRetentionSeconds: policy.answerRetentionSeconds,
            receiptRetentionDays: policy.receiptRetentionDays,
            budgetLimit: policy.purposeBudgetLimit,
            currency: policy.currency,
            unitScale: policy.unitScale,
          }
        : null,
    };
  }

  @Post('consent')
  @HttpCode(200)
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'grantAnswerConsent' })
  @ApiEnvelope(AnswerConsentDto)
  async grant(
    @Req() req: AuthenticatedRequest,
    @Body() input: GrantAnswerConsentDto,
  ): Promise<AnswerConsentDto> {
    return {
      consentEpoch: await this.answers.grant(
        req.user.ownerId,
        input.expectedConsentEpoch,
        input.policyFingerprint,
      ),
    };
  }

  @Post('consent/revoke')
  @HttpCode(200)
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'revokeAnswerConsent' })
  @ApiEnvelope(AnswerConsentDto)
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Body() input: RevokeAnswerConsentDto,
  ): Promise<AnswerConsentDto> {
    return {
      consentEpoch: await this.answers.revoke(req.user.ownerId, input.expectedConsentEpoch),
    };
  }

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiSecurity({ access: [], csrf: [] })
  @ApiOperation({ operationId: 'generateAnswer' })
  @ApiEnvelope(AnswerResultDto, 202)
  async generate(
    @Req() req: AuthenticatedRequest,
    @Body() input: GenerateAnswerDto,
  ): Promise<AnswerResultDto> {
    return this.answers.generate(req.user.ownerId, input);
  }

  @Get(':requestId')
  @Header('Cache-Control', 'no-store')
  @ApiSecurity('access')
  @ApiOperation({ operationId: 'readAnswer' })
  @ApiEnvelope(AnswerResultDto)
  async read(
    @Req() req: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<AnswerResultDto> {
    return this.answers.read(req.user.ownerId, requestId);
  }

  @Sse(':requestId/events')
  @UseGuards(AnswerStreamGuard)
  @Header('Cache-Control', 'no-store')
  @Header('X-Accel-Buffering', 'no')
  @ApiSecurity('access')
  @ApiOperation({
    operationId: 'readAnswerEvents',
    description: '저장된 처리 상태와 검증된 답변만 전송한다. AI 생성은 시작하지 않는다.',
  })
  @ApiProduces('text/event-stream')
  @ApiExtraModels(AnswerResultDto)
  @ApiOkResponse({
    content: { 'text/event-stream': { schema: { $ref: getSchemaPath(AnswerResultDto) } } },
  })
  events(
    @Req() req: AnswerStreamRequest,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Observable<MessageEvent> {
    // 첫 조회는 헤더 전송 전에 owner·동의·현재 revision을 검증한다.
    const initial = req.answerSnapshot;
    const pending = (result: AnswerResultDto) =>
      ['REQUESTED', 'RESERVED', 'RUNNING'].includes(result.state);
    const updates = pending(initial)
      ? concat(
          of(initial),
          timer(1000, 1000).pipe(
            exhaustMap(() => this.answers.read(req.user.ownerId, requestId)),
            takeWhile(pending, true),
            take(60),
          ),
        )
      : of(initial);

    // Nest가 연결 종료 시 구독과 timer를 해제한다. 네트워크 대기 동안 DB transaction은 없다.
    return updates.pipe(
      map((data) => ({ data })),
      catchError(() =>
        throwError(() => new Error('답변 상태를 확인하지 못했습니다. 다시 확인해 주세요.')),
      ),
    );
  }
}
