import { CircleAlert } from 'lucide-react';
import Image from 'next/image';
import { gowunBatang } from '../../lib/fonts';
import { Wordmark } from '../../components/wordmark';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string | string[] }>;
}) {
  const { error, returnTo } = await searchParams;
  const loginUrl =
    typeof returnTo === 'string'
      ? `/api/v1/auth/google?${new URLSearchParams({ returnTo })}`
      : '/api/v1/auth/google';

  return (
    <div
      className={`${gowunBatang.className} flex min-h-svh flex-col bg-paper-canvas text-paper-ink`}
    >
      <header className="mx-6 flex items-center justify-center border-b border-paper-rule py-5 sm:mx-12 sm:py-6 lg:mx-20">
        <Wordmark variant="stacked" />
      </header>

      <main className="mx-auto grid w-full max-w-[1440px] flex-1 content-center px-6 py-8 sm:px-12 sm:py-16 md:grid-cols-[1.2fr_1fr] lg:px-20 lg:py-24">
        <div className="md:pr-8 lg:pr-16">
          <h1 className="text-[36px] leading-[1.4] tracking-[-0.06em] sm:text-[48px] lg:text-[68px]">
            나의 기록에,
            <br />
            나의 각주를
          </h1>
          <p className="mt-4 text-lg leading-8 text-paper-muted sm:mt-8 sm:text-xl sm:leading-9">
            읽고 배운 것에 나만의 생각을 더해요. <br className="hidden sm:block" />
            다시 필요할 때, 여기서 꺼내보세요.
          </p>
        </div>

        <section
          aria-labelledby="sign-in-title"
          className="mt-8 flex flex-col justify-center border-t border-paper-rule pt-6 sm:mt-12 sm:pt-10 md:mt-0 md:border-t-0 md:border-l md:pt-0 md:pl-8 lg:pl-16 xl:pl-24"
        >
          <div className="w-full max-w-[360px]">
            <h2
              id="sign-in-title"
              className="text-[28px] leading-snug tracking-tight sm:text-[32px]"
            >
              다시, 나의 기록으로
            </h2>
            <a
              href={loginUrl}
              className="mt-6 flex min-h-14 w-full items-center justify-center gap-3 rounded border border-paper-control bg-white px-5 py-3 font-sans text-base text-paper-ink transition-colors hover:border-paper-ink hover:bg-paper-hover focus-visible:outline-paper-accent motion-reduce:transition-none sm:mt-8"
            >
              {/* Google 공식 로그인 자산: https://developers.google.com/identity/branding-guidelines */}
              <Image src="/google-g.png" alt="" width={20} height={20} unoptimized />
              구글 로그인
            </a>
            {error && (
              <div
                role="alert"
                className="mt-5 flex items-start gap-3 border-l-2 border-status-error pl-4 font-sans text-sm leading-6 text-status-error"
              >
                <CircleAlert aria-hidden="true" className="mt-1 size-4 shrink-0" />
                <p>로그인하지 못했습니다. Google로 로그인을 다시 시도해 주세요.</p>
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="mx-6 flex flex-wrap justify-between gap-2 border-t border-paper-rule py-6 font-sans text-sm text-paper-muted sm:mx-12 lg:mx-20">
        <p>조금씩 쌓이는, 나만의 기록</p>
        <span aria-hidden="true">devfootnote</span>
      </footer>
    </div>
  );
}
