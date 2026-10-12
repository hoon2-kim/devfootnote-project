import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  Body,
  Controller,
  Get,
  Head,
  HttpCode,
  HttpException,
  Module,
  Post,
  Query,
  Redirect,
  Res,
  type INestApplication,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../apps/api/dist/app.module.js';
import { Public } from '../apps/api/dist/modules/auth/decorators/public.decorator.js';
import { configureApp } from '../apps/api/dist/configure-app.js';
import { HealthService } from '../apps/api/dist/modules/health/health.service.js';
import { logger } from '../apps/api/dist/infrastructure/logging/logger.js';
import { AuthError } from '../apps/api/dist/modules/auth/index.js';
import { MaterialsError } from '../apps/api/dist/modules/materials/index.js';
import { UsageError } from '../apps/api/dist/modules/usage-retention/index.js';
import { IndexingError } from '../apps/api/dist/modules/indexing/index.js';
import { getLiveness, getReadiness } from '../packages/api-client/src/generated/index';

let domainFailure: Error;

class QueryDto {
  @IsString()
  @MaxLength(10)
  label!: string;
}

// 메시지를 등록하지 않은 제약과 중첩 DTO도 어느 필드가 틀렸는지 알려야 한다.
class TokenDto {
  @IsUUID()
  token!: string;
}
class ChildDto {
  @IsString()
  @MaxLength(5)
  name!: string;
}
class BodyDto {
  @ValidateNested()
  @Type(() => ChildDto)
  child!: ChildDto;
}

@Controller('contract-fixture')
@Public()
class FixtureController {
  @Get('domain') domain() {
    throw domainFailure;
  }
  @Get('nested') nested() {
    return { success: false };
  }
  @Get('null') empty() {
    return undefined;
  }
  @Get('unknown') unknown() {
    throw new Error('PRIVATE_SQL_TOKEN_fixture');
  }
  @Get('known') known() {
    throw new HttpException(
      { message: 'PRIVATE_SQL_TOKEN_fixture', cause: { token: 'SECRET' } },
      409,
    );
  }
  @Get('limited') limited(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Retry-After', '3');

    throw new HttpException('SECRET', 429);
  }
  @Get('validate') validate(@Query() dto: QueryDto) {
    return dto;
  }
  @Get('unmapped-status') unmappedStatus() {
    throw new HttpException('SECRET', 415);
  }
  @Get('unmapped-constraint') unmappedConstraint(@Query() dto: TokenDto) {
    return dto;
  }
  @Post('nested-validate') nestedValidate(@Body() dto: BodyDto) {
    return dto;
  }
  @Get('no-content') @HttpCode(204) noContent() {
    return undefined;
  }
  @Get('redirect') @Redirect('/login', 302) redirect() {
    return undefined;
  }
  @Get('not-modified') @HttpCode(304) notModified() {
    return undefined;
  }
  @Head('head') head() {
    return { hidden: true };
  }
}
// Vitest의 변환기는 decorator 타입 metadata를 생성하지 않는다.
Reflect.defineMetadata('design:paramtypes', [QueryDto], FixtureController.prototype, 'validate');
Reflect.defineMetadata(
  'design:paramtypes',
  [TokenDto],
  FixtureController.prototype,
  'unmappedConstraint',
);
Reflect.defineMetadata(
  'design:paramtypes',
  [BodyDto],
  FixtureController.prototype,
  'nestedValidate',
);

@Module({ imports: [AppModule], controllers: [FixtureController] })
class FixtureModule {}

describe('HTTP와 생성 SDK 계약', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/isolated_unreachable';
    const module = await Test.createTestingModule({ imports: [FixtureModule] }).compile();

    app = configureApp(module.createNestApplication({ logger: false }));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    delete process.env.DATABASE_URL;
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(
    (
      [
        [new AuthError('denied'), 401, 'AUTHENTICATION_REQUIRED', '로그인이 필요합니다.'],
        [new AuthError('unavailable'), 503, 'SERVICE_UNAVAILABLE', '잠시 후 다시 시도해 주세요.'],
        [
          new MaterialsError('revision_conflict'),
          409,
          'MATERIAL_REVISION_CONFLICT',
          '자료가 변경되었습니다. 최신 내용을 확인해 주세요.',
        ],
        [
          new UsageError('budget_exhausted'),
          409,
          'EMBEDDING_BUDGET_EXHAUSTED',
          '사용 가능한 처리 예산이 부족합니다.',
        ],
        [
          new IndexingError('consent_required'),
          403,
          'EMBEDDING_CONSENT_REQUIRED',
          '외부 전송에 대한 명시적 동의가 필요합니다.',
        ],
      ] as const
    ).map(([failure, status, error, message]) => ({ failure, status, error, message })),
  )(
    '업무 오류($error)는 HTTP $status 응답으로 변환하고 내부 정보는 숨긴다',
    async ({ failure, status, error, message }) => {
      domainFailure = failure;
      domainFailure.message = 'PRIVATE_DOMAIN_DETAIL';
      const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      await request(app.getHttpServer()).get('/api/v1/contract-fixture/domain').expect(status, {
        success: false,
        error,
        message,
      });
      expect(JSON.stringify([errorLog.mock.calls, warnLog.mock.calls])).not.toContain(
        'PRIVATE_DOMAIN_DETAIL',
      );
    },
  );

  it('인증 응답은 Express 경로 대소문자 처리와 관계없이 캐시하지 않는다', async () => {
    for (const path of ['/api/v1/auth/csrf', '/API/v1/AUTH/csrf']) {
      await request(app.getHttpServer()).get(path).expect(200).expect('Cache-Control', 'no-store');
    }
  });
  it('실제 DB 연결 거절은 인증 시작에서도 정제된 503을 반환한다', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/google').expect(503, {
      success: false,
      error: 'SERVICE_UNAVAILABLE',
      message: '잠시 후 다시 시도해 주세요.',
    });
  });
  it('간단한 health는 공통 성공 응답을 쓰고 임시 status 경로는 제공하지 않는다', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health/live')
      .expect(200, { success: true, data: { status: 'ok' } });
    await request(app.getHttpServer()).get('/api/v1/health/status').expect(404);
  });
  it('예상하지 못한 health 오류는 정제된 500이며 DB-down으로 바뀌지 않는다', async () => {
    vi.spyOn(app.get(HealthService), 'checkDatabase').mockRejectedValue(
      new Error('PRIVATE_SQL_URL_TOKEN'),
    );
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(500, {
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: '요청을 처리하지 못했습니다.',
    });
  });
  it('실제 성공 응답과 SDK transport.data를 구분한다', async () => {
    const result = await getLiveness({ baseUrl });

    expect(result.response?.status).toBe(200);
    expect(result.data).toEqual({ success: true, data: { status: 'ok' } });
  });
  it('DB가 없어도 시작·liveness는 성공하고 readiness만 503이다', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    const result = await getReadiness({ baseUrl });

    expect(result.response?.status).toBe(503);
    expect(result.error).toEqual({
      success: false,
      error: 'SERVICE_UNAVAILABLE',
      message: '잠시 후 다시 시도해 주세요.',
    });
  });
  it('success라는 데이터 필드도 일반 데이터로 감싼다', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/contract-fixture/nested')
      .expect(200, { success: true, data: { success: false } });
    await request(app.getHttpServer())
      .get('/api/v1/contract-fixture/null')
      .expect(200, { success: true, data: null });
  });
  it('unknown·HttpException 본문과 nested cause를 응답·로그에 노출하지 않는다', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await request(app.getHttpServer()).get('/api/v1/contract-fixture/unknown').expect(500, {
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: '요청을 처리하지 못했습니다.',
    });
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/known').expect(409, {
      success: false,
      error: 'CLIENT_ERROR',
      message: '요청을 처리할 수 없습니다.',
    });
    await request(app.getHttpServer())
      .get('/api/v1/contract-fixture/limited')
      .expect(429)
      .expect('Retry-After', '3');
    expect(errorLog).toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalled();
    expect(JSON.stringify([errorLog.mock.calls, warnLog.mock.calls])).not.toMatch(
      /PRIVATE_|SECRET|postgresql:\/\//,
    );
  });
  it('검증 오류를 정규화하고 unknown field·거부된 값을 반사하지 않는다', async () => {
    const invalid = await request(app.getHttpServer())
      .get('/api/v1/contract-fixture/validate?label=PRIVATE_INPUT_VALUE')
      .expect(400);

    expect(invalid.body.errors).toEqual([
      { field: 'label', code: 'maxLength', message: '허용 길이를 초과했습니다.' },
    ]);
    expect(JSON.stringify(invalid.body)).not.toContain('PRIVATE_INPUT');
    const unknown = await request(app.getHttpServer())
      .get('/api/v1/contract-fixture/validate?label=ok&PRIVATE_FIELD=SECRET')
      .expect(400);

    expect(JSON.stringify(unknown.body)).not.toMatch(/PRIVATE_FIELD|SECRET/);
  });
  it('매핑하지 않은 상태 코드도 상태 계열과 error 코드가 어긋나지 않는다', async () => {
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/unmapped-status').expect(415, {
      success: false,
      error: 'CLIENT_ERROR',
      message: '요청을 처리할 수 없습니다.',
    });
  });
  it.each([
    {
      label: '본문 크기 초과',
      contentType: 'application/json',
      contentEncoding: 'identity',
      body: JSON.stringify({ child: { name: `PRIVATE_INPUT_${'x'.repeat(110_000)}` } }),
      status: 413,
    },
    {
      label: '지원하지 않는 charset',
      contentType: 'application/json; charset=iso-8859-1',
      contentEncoding: 'identity',
      body: JSON.stringify({ child: { name: 'PRIVATE_INPUT' } }),
      status: 415,
    },
    {
      label: '지원하지 않는 content encoding',
      contentType: 'application/json',
      contentEncoding: 'unsupported-fixture',
      body: JSON.stringify({ child: { name: 'PRIVATE_INPUT' } }),
      status: 415,
    },
    {
      label: '잘못된 JSON',
      contentType: 'application/json',
      contentEncoding: 'identity',
      body: '{"PRIVATE_INPUT":',
      status: 400,
    },
  ])('실제 본문 파서의 $label 오류는 정제된 $status이다', async (fixture) => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').expect(200);
    const cookies = csrf.get('Set-Cookie') ?? [];
    const result = await request(app.getHttpServer())
      .post('/api/v1/contract-fixture/nested-validate')
      .set('Origin', 'http://127.0.0.1:3000')
      .set('X-CSRF-Token', csrf.body.data.csrfToken)
      .set(
        'Cookie',
        cookies.map((cookie) => cookie.split(';')[0] ?? ''),
      )
      .set('Content-Type', fixture.contentType)
      .set('Content-Encoding', fixture.contentEncoding)
      .send(fixture.body)
      .expect(fixture.status);

    expect(result.body).toEqual({
      success: false,
      error: fixture.status === 400 ? 'VALIDATION_ERROR' : 'CLIENT_ERROR',
      message: fixture.status === 400 ? '요청을 확인해 주세요.' : '요청을 처리할 수 없습니다.',
    });
    expect(errorLog).not.toHaveBeenCalled();
    expect(JSON.stringify([result.body, warnLog.mock.calls])).not.toContain('PRIVATE_INPUT');
  });
  it.each([
    { status: 400, statusCode: 400, expose: true },
    { status: 400, statusCode: 400, expose: true, type: 'entity.too.large' },
  ])('일반 오류의 status 속성만으로 서버 오류를 요청 오류로 바꾸지 않는다', async (properties) => {
    domainFailure = Object.assign(new Error('PRIVATE_SERVER_ERROR'), properties);

    await request(app.getHttpServer()).get('/api/v1/contract-fixture/domain').expect(500, {
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: '요청을 처리하지 못했습니다.',
    });
  });
  it('메시지를 등록하지 않은 제약과 중첩 DTO 오류도 필드를 잃지 않는다', async () => {
    const unmapped = await request(app.getHttpServer())
      .get('/api/v1/contract-fixture/unmapped-constraint?token=PRIVATE_INPUT_VALUE')
      .expect(400);

    expect(unmapped.body.errors).toEqual([
      { field: 'token', code: 'isUuid', message: '입력을 확인해 주세요.' },
    ]);
    expect(JSON.stringify(unmapped.body)).not.toContain('PRIVATE_INPUT');
    const csrf = await request(app.getHttpServer()).get('/api/v1/auth/csrf').expect(200);
    const cookies = csrf.get('Set-Cookie') ?? [];
    const nested = await request(app.getHttpServer())
      .post('/api/v1/contract-fixture/nested-validate')
      .set('Origin', 'http://127.0.0.1:3000')
      .set('X-CSRF-Token', csrf.body.data.csrfToken)
      .set(
        'Cookie',
        cookies.map((cookie) => cookie.split(';')[0] ?? ''),
      )
      .send({ child: { name: 'PRIVATE_INPUT_VALUE' } })
      .expect(400);

    expect(nested.body.errors).toEqual([
      { field: 'child.name', code: 'maxLength', message: '허용 길이를 초과했습니다.' },
    ]);
    expect(JSON.stringify(nested.body)).not.toContain('PRIVATE_INPUT');
  });
  it('204·HEAD·304·redirect의 HTTP 의미를 유지한다', async () => {
    for (const [path, status] of [
      ['no-content', 204],
      ['not-modified', 304],
    ] as const) {
      const result = await request(app.getHttpServer())
        .get(`/api/v1/contract-fixture/${path}`)
        .expect(status);

      expect(result.text).toBe('');
    }

    await request(app.getHttpServer())
      .head('/api/v1/contract-fixture/head')
      .expect(200)
      .expect((res) => expect(res.text).toBeUndefined());
    await request(app.getHttpServer())
      .get('/api/v1/contract-fixture/redirect')
      .expect(302)
      .expect('Location', '/login');
  });
});
