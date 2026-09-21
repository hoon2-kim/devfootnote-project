import 'reflect-metadata';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AuthService } from '../apps/api/dist/modules/auth/services/auth.service.js';
import { validateEnvironment } from '../apps/api/dist/config/environment.js';
import { authEnvironment, GOOGLE_SUBJECT_A } from './auth-environment.js';

// Nest의 compiled module과 같은 클래스 인스턴스를 사용한다(Vitest 변환 경계).
// Vitest(ESM)와 Playwright(CJS)에서 같은 compiled Nest 클래스를 읽는다. 테스트는 루트에서 실행한다.
const requireFixture = createRequire(resolve('tests/auth-harness.ts'));
const { AppModule }: typeof import('../apps/api/dist/app.module.js') = requireFixture(
  '../apps/api/dist/app.module.js',
);
const { configureApp }: typeof import('../apps/api/dist/configure-app.js') = requireFixture(
  '../apps/api/dist/configure-app.js',
);
const {
  GoogleStrategy,
}: typeof import('../apps/api/dist/modules/auth/strategies/google.strategy.js') = requireFixture(
  '../apps/api/dist/modules/auth/strategies/google.strategy.js',
);

class FixtureGoogleStrategy extends GoogleStrategy {
  useHttpFixture(origin: string) {
    // 테스트에서만 외부 HTTP 목적지를 바꾼다. authenticate·userProfile·validate는 원본을 실행한다.
    Object.assign(this._oauth2, { _accessTokenUrl: `${origin}/token` });
    Object.assign(this, { _userProfileURL: `${origin}/userinfo` });

    return this;
  }
}

export async function startAuthHarness(origin = 'http://127.0.0.1:3000', apiPort = 0) {
  const container = await new PostgreSqlContainer(
    'pgvector/pgvector:0.8.6-pg17-trixie@sha256:724a4041afdb1750446e3f6b5cfa8f3b0ac5a2cf538ddfa6bfee4f94c2fa85c6',
  )
    .withDatabase('auth_test')
    .start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const environment = {
    ...authEnvironment,
    DATABASE_URL: container.getConnectionUri(),
    APP_ORIGIN: origin,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );

  Object.assign(process.env, environment);
  let app: INestApplication | undefined;
  let subject = GOOGLE_SUBJECT_A;
  let googleFailure: 'token' | 'profile' | undefined;
  const googleCalls = { token: 0, profile: 0 };
  const googleServer = createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/token') {
      googleCalls.token++;
      res.statusCode = googleFailure === 'token' ? 500 : 200;
      res.end(
        JSON.stringify(
          googleFailure === 'token'
            ? { error: 'PRIVATE_GOOGLE_ERROR' }
            : { access_token: 'fixture-google-access-token', token_type: 'Bearer' },
        ),
      );
    } else if (req.method === 'GET' && req.url?.startsWith('/userinfo')) {
      googleCalls.profile++;
      res.statusCode = googleFailure === 'profile' ? 500 : 200;
      res.end(
        JSON.stringify(
          googleFailure === 'profile'
            ? { error: 'PRIVATE_GOOGLE_ERROR' }
            : { sub: subject || undefined, name: 'Test owner' },
        ),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });

  async function close() {
    try {
      await app?.close();
    } finally {
      googleServer.closeAllConnections();

      if (googleServer.listening) {
        await new Promise<void>((resolve, reject) =>
          googleServer.close((error) => (error ? reject(error) : resolve())),
        );
      }

      await pool.end();
      await container.stop();

      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  try {
    await migrate(drizzle(pool), { migrationsFolder: 'apps/api/drizzle' });
    googleServer.listen(0, '127.0.0.1');
    await once(googleServer, 'listening');
    const address = googleServer.address();

    if (!address || typeof address === 'string') {
      throw new Error('테스트 Google HTTP 주소를 확인할 수 없습니다.');
    }

    const fixtureOrigin = `http://127.0.0.1:${address.port}`;
    const settings = validateEnvironment(process.env);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(settings))
      .overrideProvider(GoogleStrategy)
      .useFactory({
        factory: (config: ConfigService) =>
          new FixtureGoogleStrategy(config).useHttpFixture(fixtureOrigin),
        inject: [ConfigService],
      })
      .compile();

    app = configureApp(module.createNestApplication({ logger: false }));
    await app.listen(apiPort, '127.0.0.1');
    const server = app.getHttpServer();

    return {
      app,
      pool,
      origin,
      callbackUrl: settings.auth.callbackUrl,
      auth: app.get(AuthService),
      googleCalls,
      async issueCsrf(cookies: string[] = []) {
        const jar = new Map(cookies.map((cookie) => [cookie.split('=')[0], cookie]));
        const response = await request(server)
          .get('/api/v1/auth/csrf')
          .set('Cookie', [...jar.values()])
          .expect(200);
        const updates = response.get('Set-Cookie') ?? [];

        for (const header of updates) {
          const cookie = header.split(';')[0] ?? '';

          jar.set(cookie.split('=')[0], cookie);
        }

        const token: string = response.body.data.csrfToken;

        return {
          token,
          cookies: [...jar.values()],
          headers: { Origin: origin, 'X-CSRF-Token': token },
        };
      },
      setSubject(value: string) {
        subject = value;
      },
      setGoogleFailure(value: typeof googleFailure) {
        googleFailure = value;
      },
      resetGoogleCalls() {
        googleCalls.token = 0;
        googleCalls.profile = 0;
      },
      close,
    };
  } catch (error) {
    await close();

    throw error;
  }
}
