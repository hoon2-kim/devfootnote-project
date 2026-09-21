export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  origin: string;
  secureCookies: boolean;
  accessSecret: string;
  refreshSecret: string;
  csrfSecret: string;
}

export interface TokenClaims {
  sub: string;
  exp: number;
  token_use: 'access' | 'refresh';
  jti: string;
}

export interface SessionTokens {
  access: string;
  refresh: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface OAuthState {
  stateHash: string;
  bindingHash: string;
  expiresAt: Date;
  returnTo: string;
}
