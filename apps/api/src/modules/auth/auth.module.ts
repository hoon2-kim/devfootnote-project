import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { AuthService } from './services/auth.service.js';
import { TokenService } from './services/token.service.js';
import { AuthRepository } from './repositories/auth.repository.js';
import { AuthController } from './auth.controller.js';
import { AccessTokenGuard } from './guards/access-token.guard.js';
import { RefreshTokenGuard } from './guards/refresh-token.guard.js';
import { AccessTokenStrategy } from './strategies/access-token.strategy.js';
import { RefreshTokenStrategy } from './strategies/refresh-token.strategy.js';
import { GoogleStrategy } from './strategies/google.strategy.js';
import { GoogleLoginGuard } from './guards/google-login.guard.js';
import { GoogleCallbackGuard } from './guards/google-callback.guard.js';
import { CsrfService } from './services/csrf.service.js';

@Module({
  imports: [DatabaseModule, JwtModule.register({}), PassportModule.register({ session: false })],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    AuthRepository,
    GoogleStrategy,
    GoogleLoginGuard,
    GoogleCallbackGuard,
    AccessTokenStrategy,
    RefreshTokenStrategy,
    RefreshTokenGuard,
    CsrfService,
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [AuthService, CsrfService],
})
export class AuthModule {}
