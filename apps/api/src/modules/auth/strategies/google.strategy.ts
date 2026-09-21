import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-google-oauth20';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('auth.clientId'),
      clientSecret: config.getOrThrow<string>('auth.clientSecret'),
      callbackURL: config.getOrThrow<string>('auth.callbackUrl'),
      scope: ['profile'],
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: Profile) {
    return { googleId: profile.id };
  }
}
