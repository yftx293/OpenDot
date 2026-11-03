import { useSyncExternalStore } from 'react';

let keyboardHeight = 0;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

// One viewport subscription shared by the app observer and individual composers.
// Leaving a conversation must not reset a still-open form Sheet's viewport.
function watchViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    const height =
      viewport.scale > 1
        ? 0
        : Math.max(
            0,
            window.innerHeight - viewport.height - viewport.offsetTop,
          );
    if (height === keyboardHeight) return;
    keyboardHeight = height;
    document.documentElement.style.setProperty(
      '--keyboard-height',
      `${height}px`,
    );
    for (const notify of listeners) notify();
  };
  const focus = (event: FocusEvent) => {
    const target = event.target;
    if (
      !(
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement
      )
    )
      return;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (target.isConnected)
        target.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches
            ? 'auto'
            : 'smooth',
          block: 'nearest',
        });
    }, 300);
  };
  viewport.addEventListener('resize', measure);
  viewport.addEventListener('scroll', measure);
  window.addEventListener('resize', measure);
  document.addEventListener('focusin', focus);
  measure();
  return () => {
    clearTimeout(focusTimer);
    viewport.removeEventListener('resize', measure);
    viewport.removeEventListener('scroll', measure);
    window.removeEventListener('resize', measure);
    document.removeEventListener('focusin', focus);
  };
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) stop = watchViewport();
  return () => {
    listeners.delete(notify);
    if (listeners.size) return;
    stop?.();
    stop = undefined;
    keyboardHeight = 0;
    document.documentElement.style.setProperty('--keyboard-height', '0px');
  };
}
export function useKeyboardHeight() {
  const height = useSyncExternalStore(
    subscribe,
    () => keyboardHeight,
    () => 0,
  );
  return { keyboardHeight: height, isKeyboardVisible: height > 0 };
}
/** Tracks form Sheets without re-rendering the complete app shell on resize. */
export function KeyboardViewportObserver() {
  useKeyboardHeight();
  return null;
}
