import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useKeyboardHeight } from '../../hooks/useKeyboardHeight';

/** Layout only: no submission, draft, ownership or execution state. */
export function ConversationDock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { keyboardHeight } = useKeyboardHeight();
  useLayoutEffect(() => {
    const canvas = ref.current?.closest<HTMLElement>(
      '[data-conversation-canvas]',
    );
    if (canvas) canvas.dataset.keyboardVisible = String(keyboardHeight > 0);
  }, [keyboardHeight]);
  useLayoutEffect(() => {
    const dock = ref.current;
    const canvas = dock?.closest<HTMLElement>('[data-conversation-canvas]');
    if (!dock || !canvas) return;
    const measure = () =>
      canvas.style.setProperty(
        '--composer-height',
        `${dock.getBoundingClientRect().height}px`,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    measure();
    return () => {
      observer.disconnect();
      canvas.style.removeProperty('--composer-height');
    };
  }, []);
  return (
    <div ref={ref} data-composer-dock className="conversation-dock">
      {children}
    </div>
  );
}
