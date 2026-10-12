'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './button';

export function ConfirmDialog({
  open,
  title,
  children,
  busy,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  busy: boolean;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-description"
      onCancel={(event) => {
        event.preventDefault();

        if (!busy) {
          onCancel();
        }
      }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border-subtle bg-surface p-6 text-text-primary backdrop:bg-black/40"
    >
      <h2 id="confirm-title" className="text-xl font-semibold">
        {title}
      </h2>
      <div id="confirm-description" className="mt-4 text-sm leading-6 text-text-secondary">
        {children}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button autoFocus disabled={busy} onClick={onCancel}>
          취소
        </Button>
        <Button disabled={busy || confirmDisabled} onClick={onConfirm} variant="destructive">
          {busy ? '삭제 중…' : '삭제 확인'}
        </Button>
      </div>
    </dialog>
  );
}
