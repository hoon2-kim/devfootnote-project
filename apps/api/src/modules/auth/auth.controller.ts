import { Controller, Get, Post, Req, Res, UseGuards, HttpCode } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthError } from './auth.error.js';
import { AuthService } from './services/auth.service.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { Request, Response } from 'express';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.constants.js';
import { authCookieOptions, readCookie, setTokenCookies } from './auth.cookies.js';
import { Public } from './decorators/public.decorator.js';
import { RefreshTokenGuard } from './guards/refresh-token.guard.js';
import { GoogleLoginGuard } from './guards/google-login.guard.js';
import { GoogleCallbackGuard } from './guards/google-callback.guard.js';
import type {
  AuthenticatedRequest,
  GoogleAuthenticatedRequest,
  RefreshAuthenticatedRequest,
} from './auth-request.types.js';
import { CsrfTokenDto, OwnerDto } from './dto/response/auth-response.dto.js';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator.js';
import { ApiErrorDto } from '../../common/dto/api-error.dto.js';
import { CsrfService } from './services/csrf.service.js';

@Controller('auth')
@ApiInternalServerErrorResponse({ type: ApiErrorDto, description: '예상하지 못한 인증 처리 오류' })
@ApiServiceUnavailableResponse({
  type: ApiErrorDto,
  description: '인증 저장소 또는 제공자 연결 실패',
})
@ApiForbiddenResponse({ type: ApiErrorDto, description: '요청 출처 또는 CSRF 검증 실패' })
@ApiUnauthorizedResponse({ type: ApiErrorDto, description: '유효한 인증이 필요함' })
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly csrf: CsrfService,
    config: ConfigService,
  ) {
    this.secureCookies = config.getOrThrow<boolean>('auth.secureCookies');
  }

  @Get('google')
  @Public()
  @UseGuards(GoogleLoginGuard)
  @ApiOperation({ operationId: 'beginGoogleLogin' })
  @ApiQuery({
    name: 'returnTo',
    required: false,
    type: String,
    description: '허용된 자료함·검색·문서 상대 경로. 유효하지 않으면 /library로 복귀한다.',
  })
  @ApiResponse({ status: 302, description: 'Google 인증 화면으로 이동' })
  begin() {}

  @Get('google/callback')
  @Public()
  @UseGuards(GoogleCallbackGuard)
  @ApiOperation({ operationId: 'completeGoogleLogin' })
  @ApiResponse({
    status: 302,
    description:
      '인증 성공 시 검증해 저장한 복귀 경로, 실패 시 일반 오류가 있는 로그인 화면으로 이동',
  })
  async callback(@Req() req: GoogleAuthenticatedRequest, @Res() res: Response) {
    try {
      const tokens = await this.auth.completeLogin(req.user.googleId);

      this.csrf.rotate(req, res);
      setTokenCookies(res, tokens, this.secureCookies);
      res.redirect(302, req.loginReturnTo);
    } catch (error) {
      if (!(error instanceof AuthError) || error.kind !== 'denied') {
        logger.error('로그인 완료 처리에 실패했습니다.');
      }

      res.redirect(302, '/login?error=authentication_failed');
    }
  }

  @Get('csrf')
  @Public()
  @ApiOperation({ operationId: 'getCsrfToken' })
  @ApiEnvelope(CsrfTokenDto)
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrfToken: this.csrf.getToken(req, res) };
  }

  @Get('me')
  @ApiCookieAuth('access')
  @ApiOperation({ operationId: 'getMe' })
  @ApiEnvelope(OwnerDto)
  me(@Req() req: AuthenticatedRequest) {
    return { ownerId: req.user.ownerId };
  }

  @Post('refresh')
  @Public()
  @UseGuards(RefreshTokenGuard)
  @HttpCode(204)
  @ApiSecurity({ refresh: [], csrf: [] })
  @ApiOperation({ operationId: 'refreshAuthentication' })
  @ApiNoContentResponse({ description: 'JWT 쿠키 교체 완료' })
  async refresh(
    @Req() req: RefreshAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Guard 는 claim 만 넘긴다 — CAS 에는 저장된 hash 와 맞출 원문이 필요하다.
    const token = readCookie(req, REFRESH_COOKIE) ?? '';
    const tokens = await this.auth.refresh(token, req.user);

    setTokenCookies(res, tokens, this.secureCookies);
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiSecurity('csrf')
  @ApiOperation({ operationId: 'logout' })
  @ApiNoContentResponse({ description: '현재 refresh 철회 및 쿠키 삭제' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readCookie(req, REFRESH_COOKIE));
    res.clearCookie(ACCESS_COOKIE, authCookieOptions(this.secureCookies, '/'));
    res.clearCookie(REFRESH_COOKIE, authCookieOptions(this.secureCookies, '/api/v1/auth'));
    this.csrf.clear(res);
  }
}
