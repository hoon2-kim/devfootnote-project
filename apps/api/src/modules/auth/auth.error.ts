// denied → 401, unavailable → 503으로 옮기며 공개 message는 GlobalExceptionFilter가 구성한다.
export class AuthError extends Error {
  constructor(readonly kind: 'denied' | 'unavailable') {
    super('인증 요청을 처리하지 못했습니다.');
  }
}
