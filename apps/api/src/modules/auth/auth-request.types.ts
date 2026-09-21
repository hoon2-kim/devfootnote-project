import type { Request } from 'express';
import type { TokenClaims } from './auth.types.js';

export interface AuthenticatedRequest extends Request {
  user: { ownerId: string };
}

export interface GoogleAuthenticatedRequest extends Request {
  user: { googleId: string };
  loginReturnTo: string;
}

export interface RefreshAuthenticatedRequest extends Request {
  user: TokenClaims;
}
