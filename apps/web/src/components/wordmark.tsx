import Image from 'next/image';

export function Wordmark({ variant = 'horizontal' }: { variant?: 'horizontal' | 'stacked' }) {
  const stacked = variant === 'stacked';

  return (
    <span className="inline-flex min-w-0 max-w-full align-middle">
      <Image
        src={`/brand/devfootnote-${variant}.svg`}
        alt="devfootnote"
        width={stacked ? 423 : 491}
        height={stacked ? 240 : 96}
        className={`h-auto max-w-full ${stacked ? 'w-44' : 'w-40 sm:w-48'}`}
        loading="eager"
        unoptimized
      />
    </span>
  );
}
