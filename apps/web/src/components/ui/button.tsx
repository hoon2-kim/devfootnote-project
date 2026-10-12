import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

// shadcn/ui의 Radix Button 패턴. 현재 쓰는 variant만 두고 devfootnote 토큰을 적용한다.
const buttonVariants = cva(
  'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium motion-safe:transition-colors disabled:cursor-not-allowed disabled:bg-paper-hover disabled:text-text-muted [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // 비활성 색에서 돌아오는 중간색도 읽을 수 있어야 하므로 primary 색은 즉시 바꾼다.
        primary:
          'bg-action-primary text-white hover:bg-action-pressed active:bg-action-pressed motion-safe:transition-none',
        outline:
          'border border-paper-control bg-surface text-text-primary hover:bg-paper-hover active:bg-border-subtle',
        ghost: 'text-text-secondary hover:bg-paper-hover active:bg-border-subtle',
        destructive:
          'bg-status-destructive text-white hover:bg-status-destructive/90 active:bg-status-destructive motion-safe:transition-none',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';

  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}
