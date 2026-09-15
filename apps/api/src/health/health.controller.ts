import { Controller, Get, Inject } from '@nestjs/common';
import { ApiInternalServerErrorResponse, ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse } from '@nestjs/swagger';
import { HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { BackendHealthService } from '@devfootnote/backend';

@Controller('health')
@ApiInternalServerErrorResponse({ description: '예상하지 못한 서버 오류' })
export class HealthController {
  constructor(
    @Inject(BackendHealthService) private readonly backend: BackendHealthService,
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(HealthIndicatorService) private readonly indicators: HealthIndicatorService,
  ) {}

  @Get('live')
  @ApiOperation({ operationId: 'getLiveness' })
  @ApiOkResponse({ description: '프로세스 응답 가능' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ operationId: 'getReadiness' })
  @ApiOkResponse({ description: 'DB 연결 확인 성공' })
  @ApiServiceUnavailableResponse({ description: 'DB 연결 확인 실패 또는 timeout' })
  async ready() {
    await this.health.check([async () => {
      const postgres = this.indicators.check('postgres');
      return await this.backend.checkDatabase() ? postgres.up() : postgres.down();
    }]);
    return { status: 'ok' };
  }
}
