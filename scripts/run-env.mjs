import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const [app, mode, ...command] = process.argv.slice(2);

if (!['api', 'web', 'worker'].includes(app) || !['dev', 'prod'].includes(mode) || !command.length) {
  throw new Error('실행 대상(api/web/worker), 환경(dev/prod), Node 실행 파일을 지정해 주세요.');
}

// Next가 CLI 옵션을 NODE_OPTIONS로 전달하므로 env-file 플래그 대신 여기서 읽는다.
// 셸·운영 환경에서 이미 주입한 값은 Node의 우선순위에 따라 보존한다.
const envPath = fileURLToPath(new URL(`../apps/${app}/.env.${mode}`, import.meta.url));

try {
  loadEnvFile(envPath);
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
    console.error('앱 환경 파일을 읽지 못했습니다.');
    process.exit(1);
  }
}

const child = spawn(process.execPath, command, {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: mode === 'dev' ? 'development' : 'production' },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', () => {
  console.error('앱 실행에 실패했습니다.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
