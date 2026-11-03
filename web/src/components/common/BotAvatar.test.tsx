// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { BotAvatar, type BotAvatarProps } from './BotAvatar';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
async function render(props: Partial<BotAvatarProps> = {}) {
  if (!host) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(<BotAvatar botId="researcher" name="Researcher" {...props} />),
  );
  return host.firstElementChild as HTMLElement;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('state, name and size changes preserve identity and visible text alternatives', async () => {
  const element = await render();
  const seed = element.dataset.avatarSeed;
  await render({ name: 'Renamed', state: 'working', size: 'lg' });
  expect(element.dataset.avatarSeed).toBe(seed);
  expect(element.getAttribute('aria-label')).toBe('Renamed · 正在工作');
  expect(element.dataset.state).toBe('working');
  await render({ botId: 'developer' });
  expect(element.dataset.avatarSeed).not.toBe(seed);
});
test('uploaded image wins, then explicit emoji, then stable generated face', async () => {
  await render({
    imageUrl: '/broken-avatar.png',
    emoji: '🐱',
    color: '#123456',
  });
  expect(host!.querySelector('img')?.getAttribute('src')).toBe(
    '/broken-avatar.png',
  );
  await act(async () =>
    host!.querySelector('img')!.dispatchEvent(new Event('error')),
  );
  expect(host!.textContent).toContain('🐱');
  await render({ imageUrl: '/broken-avatar.png' });
  expect(host!.querySelector('[data-generated-avatar]')).not.toBeNull();
  await render({ imageUrl: '/new-avatar.png' });
  expect(host!.querySelector('img')?.getAttribute('src')).toBe(
    '/new-avatar.png',
  );
});
test('decorative avatars do not duplicate adjacent accessible Bot names', async () => {
  const element = await render({ decorative: true });
  expect(element.getAttribute('aria-hidden')).toBe('true');
  expect(element.hasAttribute('aria-label')).toBe(false);
});
test('one visibility observer pauses offscreen and cleans up when the last avatar leaves', async () => {
  let callback: IntersectionObserverCallback | undefined;
  const observe = vi.fn(),
    unobserve = vi.fn(),
    disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(fn: IntersectionObserverCallback) {
        callback = fn;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const element = await render({ state: 'working' });
  expect(element.dataset.visible).toBe('false');
  const entry = (isIntersecting: boolean): IntersectionObserverEntry => ({
    target: element,
    isIntersecting,
    boundingClientRect: element.getBoundingClientRect(),
    intersectionRect: element.getBoundingClientRect(),
    intersectionRatio: isIntersecting ? 1 : 0,
    rootBounds: null,
    time: 0,
  });
  callback!([entry(true)], {} as IntersectionObserver);
  expect(element.dataset.visible).toBe('true');
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(element.dataset.visible).toBe('false');
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(element.dataset.visible).toBe('true');
  callback!([entry(false)], {} as IntersectionObserver);
  expect(element.dataset.visible).toBe('false');
  act(() => root!.unmount());
  root = undefined;
  expect(unobserve).toHaveBeenCalledWith(element);
  expect(disconnect).toHaveBeenCalledOnce();
});

test('attention, error, working and thinking remain distinct without color', async () => {
  const marks = new Set<string | null>();
  for (const state of ['attention', 'error', 'working', 'thinking'] as const) {
    await render({ state });
    marks.add(
      host!.querySelector('.bot-avatar-status path')!.getAttribute('d'),
    );
  }
  expect(marks.size).toBe(4);
});
