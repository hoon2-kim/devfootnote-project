export default function LoginPage() {
  return (
    <main className="mx-auto mt-[15vh] mb-8 box-border w-[min(100%-2rem,480px)] rounded-xl border border-border-subtle bg-surface p-8 [overflow-wrap:anywhere]">
      <h1 className="mb-4 text-[32px] leading-tight font-semibold">devfootnote</h1>
      <p className="text-text-secondary">개발 메모와 근거 자료를 모아 두는 나만의 자료함입니다.</p>
      {/* 준비 중인 동작이지만 안내에 도달할 수 있어야 하므로 focus 가능한 aria-disabled를 쓴다. */}
      <button
        type="button"
        aria-disabled="true"
        aria-describedby="login-notice"
        className="mt-6 min-h-11 cursor-not-allowed rounded-lg border border-text-muted bg-surface px-4 py-2 text-text-secondary"
      >
        Google로 로그인
      </button>
      <p id="login-notice" className="mt-6 text-text-muted">로그인 기능을 준비하고 있습니다.</p>
    </main>
  );
}
