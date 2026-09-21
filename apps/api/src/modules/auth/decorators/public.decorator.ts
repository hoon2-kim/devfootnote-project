import { SetMetadata } from '@nestjs/common';

// 모든 feature 가 쓰지만 의존성이 없어 auth 가 아닌 common 에 둔다. 읽는 쪽은 AccessTokenGuard 하나다.
export const IS_PUBLIC_KEY = 'auth:public';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
