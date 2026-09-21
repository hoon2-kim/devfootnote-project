import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  // 브라우저 검증이 실행 중인 로컬 개발 서버의 lock·빌드 산출물을 공유하지 않게 한다.
  distDir: process.env.PLAYWRIGHT_TEST === '1' ? '.next-playwright' : '.next',
  transpilePackages: ['@devfootnote/api-client'],
  // 브라우저는 web origin만 사용한다. 목적지는 서버 전용이며 빌드 시에도 같은 값을 주입한다.
  rewrites() {
    const upstream = process.env.API_UPSTREAM_URL ?? 'http://127.0.0.1:8000';

    return [{ source: '/api/v1/:path*', destination: `${upstream}/api/v1/:path*` }];
  },
};

export default config;
