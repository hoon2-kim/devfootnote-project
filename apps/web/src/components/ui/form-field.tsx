import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

const fieldClass =
  'min-h-11 w-full rounded border border-text-muted bg-surface px-3 py-2 text-base placeholder:text-text-placeholder aria-invalid:border-status-error disabled:bg-canvas';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'resize-y', className)} {...props} />;
}

export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      {children}
      <div id={`${id}-help`} className="text-sm leading-6">
        {error ? (
          <p className="text-status-error">{error}</p>
        ) : (
          hint && <p className="text-text-muted">{hint}</p>
        )}
      </div>
    </div>
  );
}
