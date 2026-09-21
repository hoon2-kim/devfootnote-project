// 실제 환경 파일을 읽지 않는 격리된 합성 설정. 운영 인증을 우회하는 앱 옵션은 없다.
export const GOOGLE_SUBJECT_A = 'fixture-owner';
export const GOOGLE_SUBJECT_B = 'fixture-other-user';

export const authEnvironment = {
  APP_ORIGIN: 'http://127.0.0.1:3000',
  GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'fixture-client-secret',
  JWT_ACCESS_SECRET: '0123456789abcdef'.repeat(4),
  JWT_REFRESH_SECRET: 'fedcba9876543210'.repeat(4),
  CSRF_SECRET: 'fixture-csrf-secret-0123456789abcdef'.repeat(2),
};
