import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function startImageStack() {
  const directory = await mkdtemp(join(tmpdir(), 'devfootnote-https-'));
  const project = `devfootnote-smoke-${randomUUID().slice(0, 8)}`;
  let webPort = 0;

  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=devfootnote.test',
    '-keyout',
    join(directory, 'key.pem'),
    '-out',
    join(directory, 'cert.pem'),
  ]);
  const proxy = createServer(
    {
      key: await readFile(join(directory, 'key.pem')),
      cert: await readFile(join(directory, 'cert.pem')),
    },
    (req, res) => {
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port: webPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            'x-forwarded-proto': 'https',
            'x-forwarded-host': req.headers.host,
          },
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );

      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502);
        }

        res.end();
      });
      req.pipe(upstream);
    },
  );

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address();

  if (!address || typeof address === 'string') {
    throw new Error('HTTPS 테스트 포트를 확인하지 못했습니다.');
  }

  const origin = `https://devfootnote.test:${address.port}`;
  const args = [
    'compose',
    '--env-file',
    '/dev/null',
    '-p',
    project,
    '-f',
    'docker-compose.yml',
    '-f',
    'tests/images/compose.yml',
    '--profile',
    'app',
  ];

  async function compose(...command: string[]) {
    return exec('docker', [...args, ...command], {
      env: { ...process.env, SMOKE_ORIGIN: origin },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 600_000,
    });
  }

  async function refreshWebPort() {
    const port = await compose('port', 'web', '3000');

    webPort = Number(port.stdout.trim().split(':').at(-1));
  }

  async function restart() {
    await compose('restart', 'postgres', 'api', 'web');
    await compose('up', '-d', '--wait', 'postgres', 'api', 'web');
    // Docker의 동적 publish 포트는 재시작 뒤 다시 확인한다.
    await refreshWebPort();
  }

  async function close() {
    try {
      // 고유 project의 테스트 컨테이너·네트워크·볼륨만 제거한다.
      await compose('down', '--volumes', '--remove-orphans');
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  }

  try {
    await compose('build', 'api', 'web', 'migration');
    await compose('up', '-d', '--wait', 'postgres', 'google');
    await compose('run', '--rm', 'migration');
    await compose('up', '-d', '--wait', 'api', 'web');
    await refreshWebPort();

    return { origin, compose, restart, close };
  } catch (error) {
    await close();

    throw error;
  }
}
