import { LoaderCircle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Wordmark } from '../../components/wordmark';
import { usePathname } from 'next/navigation';

export function AuthHeader({
  signingOut,
  onSignOut,
}: {
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const pathname = usePathname();

  return (
    <header className="bg-paper-canvas text-paper-ink [--color-focus:var(--color-paper-accent)]">
      <div className="mx-auto grid max-w-5xl grid-cols-[1fr_auto] items-center gap-x-6 border-b border-paper-rule px-6 pt-5 sm:grid-cols-[1fr_auto_auto] sm:px-8 sm:py-5">
        <Wordmark />
        <Button
          type="button"
          variant="ghost"
          disabled={signingOut}
          onClick={onSignOut}
          className="rounded text-paper-muted hover:bg-paper-hover sm:col-start-3 sm:row-start-1"
        >
          {signingOut ? (
            <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
          ) : null}
          {signingOut ? '로그아웃 중…' : '로그아웃'}
        </Button>
        <nav
          aria-label="주 메뉴"
          className="col-span-2 mt-4 flex gap-6 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:mt-0"
        >
          <a
            href="/library"
            aria-current={pathname === '/library' ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center border-b-2 ${pathname === '/search' ? 'border-transparent text-paper-muted' : 'border-paper-accent text-paper-ink'} px-1 text-sm font-semibold hover:text-paper-ink`}
          >
            자료함
          </a>
          <a
            href="/search"
            aria-current={pathname === '/search' ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center border-b-2 ${pathname === '/search' ? 'border-paper-accent text-paper-ink' : 'border-transparent text-paper-muted'} px-1 text-sm font-semibold hover:text-paper-ink`}
          >
            검색
          </a>
        </nav>
      </div>
    </header>
  );
}
