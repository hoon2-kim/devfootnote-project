// 테스트 컨테이너에만 mount한다. production 코드에 인증 우회 옵션을 추가하지 않는다.
// 서명·state·Passport 검증은 유지하고 Google 서버의 두 응답 주소만 바꾼다.
const { GoogleStrategy } = await import('/app/dist/modules/auth/strategies/google.strategy.js');
const authenticate = GoogleStrategy.prototype.authenticate;

GoogleStrategy.prototype.authenticate = function (request, options) {
  this._oauth2._accessTokenUrl = 'http://google:8080/token';
  this._userProfileURL = 'http://google:8080/userinfo';

  return authenticate.call(this, request, options);
};
