import { gowunBatang } from '../lib/fonts';

export function Wordmark() {
  return (
    <span
      className={`${gowunBatang.className} inline-flex items-start gap-1 text-[26px] tracking-tight text-paper-ink`}
    >
      devfootnote
      <span aria-hidden="true" className="mt-1 text-base text-paper-accent">
        *
      </span>
    </span>
  );
}
