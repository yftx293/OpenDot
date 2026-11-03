// One observer for every mounted avatar. No animation timers or per-frame React work.
const elements = new Map<HTMLElement, boolean>();
let observer: IntersectionObserver | undefined;
function apply(element: HTMLElement, visible: boolean) {
  element.dataset.visible = String(
    visible && document.visibilityState !== 'hidden',
  );
}
function pageVisibility() {
  for (const [element, visible] of elements) apply(element, visible);
}
export function observeAvatar(element: HTMLElement) {
  if (!elements.size) {
    if (typeof IntersectionObserver !== 'undefined')
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const target = entry.target as HTMLElement;
            if (!elements.has(target)) continue;
            elements.set(target, entry.isIntersecting);
            apply(target, entry.isIntersecting);
          }
        },
        { rootMargin: '0px' },
      );
    document.addEventListener('visibilitychange', pageVisibility);
  }
  elements.set(element, !observer);
  apply(element, !observer);
  observer?.observe(element);
  return () => {
    observer?.unobserve(element);
    elements.delete(element);
    if (elements.size) return;
    observer?.disconnect();
    observer = undefined;
    document.removeEventListener('visibilitychange', pageVisibility);
  };
}
