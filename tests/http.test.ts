import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { Body, Controller, Get, Head, HttpCode, HttpException, Module, Post, Query, Redirect, Res, type INestApplication } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import request from 'supertest';
import { AppModule } from '../apps/api/dist/app.module.js';
import { configureApp } from '../apps/api/dist/configure-app.js';
import { BackendHealthService, logger } from '../packages/backend/dist/index.js';
import { getLiveness, getReadiness } from '../packages/api-client/src/generated/index';

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
class FixtureController {
  @Get('nested') nested() { return { success: false }; }
  @Get('null') empty() { return undefined; }
  @Get('unknown') unknown() { throw new Error('PRIVATE_SQL_TOKEN_fixture'); }
  @Get('known') known() { throw new HttpException({ message: 'PRIVATE_SQL_TOKEN_fixture', cause: { token: 'SECRET' } }, 409); }
  @Get('limited') limited(@Res({ passthrough: true }) res: Response) { res.setHeader('Retry-After', '3'); throw new HttpException('SECRET', 429); }
  @Get('validate') validate(@Query() dto: QueryDto) { return dto; }
  @Get('unmapped-status') unmappedStatus() { throw new HttpException('SECRET', 415); }
  @Get('unmapped-constraint') unmappedConstraint(@Query() dto: TokenDto) { return dto; }
  @Post('nested-validate') nestedValidate(@Body() dto: BodyDto) { return dto; }
  @Get('no-content') @HttpCode(204) noContent() { return undefined; }
  @Get('redirect') @Redirect('/login', 302) redirect() { return undefined; }
  @Get('not-modified') @HttpCode(304) notModified() { return undefined; }
  @Head('head') head() { return { hidden: true }; }
}
// Vitest의 변환기는 decorator 타입 metadata를 생성하지 않는다.
Reflect.defineMetadata('design:paramtypes', [QueryDto], FixtureController.prototype, 'validate');
Reflect.defineMetadata('design:paramtypes', [TokenDto], FixtureController.prototype, 'unmappedConstraint');
Reflect.defineMetadata('design:paramtypes', [BodyDto], FixtureController.prototype, 'nestedValidate');

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
  afterAll(async () => { await app?.close(); delete process.env.DATABASE_URL; });
  afterEach(() => vi.restoreAllMocks());

  it('간단한 health는 공통 성공 응답을 쓰고 임시 status 경로는 제공하지 않는다', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/live')
      .expect(200, { success: true, data: { status: 'ok' } });
    await request(app.getHttpServer()).get('/api/v1/health/status').expect(404);
  });
  it('예상하지 못한 health 오류는 정제된 500이며 DB-down으로 바뀌지 않는다', async () => {
    vi.spyOn(app.get(BackendHealthService), 'checkDatabase').mockRejectedValue(new Error('PRIVATE_SQL_URL_TOKEN'));
    await request(app.getHttpServer()).get('/api/v1/health/ready')
      .expect(500, { success: false, error: 'INTERNAL_SERVER_ERROR', message: '요청을 처리하지 못했습니다.' });
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
    expect(result.error).toEqual({ success: false, error: 'SERVICE_UNAVAILABLE', message: '잠시 후 다시 시도해 주세요.' });
  });
  it('success라는 데이터 필드도 일반 데이터로 감싼다', async () => {
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/nested').expect(200, { success: true, data: { success: false } });
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/null').expect(200, { success: true, data: null });
  });
  it('unknown·HttpException 본문과 nested cause를 응답·로그에 노출하지 않는다', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/unknown').expect(500, { success: false, error: 'INTERNAL_SERVER_ERROR', message: '요청을 처리하지 못했습니다.' });
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/known').expect(409, { success: false, error: 'CLIENT_ERROR', message: '요청을 처리할 수 없습니다.' });
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/limited').expect(429).expect('Retry-After', '3');
    expect(errorLog).toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalled();
    expect(JSON.stringify([errorLog.mock.calls, warnLog.mock.calls])).not.toMatch(/PRIVATE_|SECRET|postgresql:\/\//);
  });
  it('검증 오류를 정규화하고 unknown field·거부된 값을 반사하지 않는다', async () => {
    const invalid = await request(app.getHttpServer()).get('/api/v1/contract-fixture/validate?label=PRIVATE_INPUT_VALUE').expect(400);
    expect(invalid.body.errors).toEqual([{ field: 'label', code: 'maxLength', message: '허용 길이를 초과했습니다.' }]);
    expect(JSON.stringify(invalid.body)).not.toContain('PRIVATE_INPUT');
    const unknown = await request(app.getHttpServer()).get('/api/v1/contract-fixture/validate?label=ok&PRIVATE_FIELD=SECRET').expect(400);
    expect(JSON.stringify(unknown.body)).not.toMatch(/PRIVATE_FIELD|SECRET/);
  });
  it('매핑하지 않은 상태 코드도 상태 계열과 error 코드가 어긋나지 않는다', async () => {
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/unmapped-status')
      .expect(415, { success: false, error: 'CLIENT_ERROR', message: '요청을 처리할 수 없습니다.' });
  });
  it('메시지를 등록하지 않은 제약과 중첩 DTO 오류도 필드를 잃지 않는다', async () => {
    const unmapped = await request(app.getHttpServer()).get('/api/v1/contract-fixture/unmapped-constraint?token=PRIVATE_INPUT_VALUE').expect(400);
    expect(unmapped.body.errors).toEqual([{ field: 'token', code: 'isUuid', message: '입력을 확인해 주세요.' }]);
    expect(JSON.stringify(unmapped.body)).not.toContain('PRIVATE_INPUT');
    const nested = await request(app.getHttpServer()).post('/api/v1/contract-fixture/nested-validate')
      .send({ child: { name: 'PRIVATE_INPUT_VALUE' } }).expect(400);
    expect(nested.body.errors).toEqual([{ field: 'child.name', code: 'maxLength', message: '허용 길이를 초과했습니다.' }]);
    expect(JSON.stringify(nested.body)).not.toContain('PRIVATE_INPUT');
  });
  it('204·HEAD·304·redirect의 HTTP 의미를 유지한다', async () => {
    for (const [path, status] of [['no-content', 204], ['not-modified', 304]] as const) {
      const result = await request(app.getHttpServer()).get(`/api/v1/contract-fixture/${path}`).expect(status);
      expect(result.text).toBe('');
    }
    await request(app.getHttpServer()).head('/api/v1/contract-fixture/head').expect(200).expect(res => expect(res.text).toBeUndefined());
    await request(app.getHttpServer()).get('/api/v1/contract-fixture/redirect').expect(302).expect('Location', '/login');
  });
});
