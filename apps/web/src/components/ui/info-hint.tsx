'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Button } from './button';

// native popover의 바깥 클릭·Escape 해제를 사용한다. 터치에서도 설명을 열 수 있다.
export function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  function locate() {
    const bounds = trigger.current?.getBoundingClientRect();

    if (bounds) {
      setPosition({
        top: Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - 240)),
        left: Math.max(12, Math.min(bounds.left, window.innerWidth - 332)),
      });
    }
  }

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        popoverTarget={id}
        popoverTargetAction="show"
        onClick={locate}
        onFocus={() => {
          locate();
          content.current?.showPopover();
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') {
            return;
          }

          locate();
          content.current?.showPopover();
        }}
        className="px-2 text-text-muted"
      >
        <Info aria-hidden="true" />
      </Button>
      <div
        ref={content}
        id={id}
        role="tooltip"
        popover="auto"
        onToggle={(event) => setOpen(event.newState === 'open')}
        style={position}
        className="fixed m-0 w-[min(320px,calc(100vw-24px))] rounded-xl border border-paper-rule bg-surface p-4 text-sm leading-6 text-text-secondary shadow-lg"
      >
        {children}
      </div>
    </>
  );
}
