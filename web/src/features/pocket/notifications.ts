import { APP_BASE, withBasePath } from '../../utils/url';
import { appNotificationIconUrl } from '../../utils/brand';

const PREFERENCE = 'miniclaw:pocket:notifications';
let enabled =
  typeof Notification !== 'undefined' && Notification.permission === 'granted';
let lastNoticeAt = 0;
let notificationEpoch = 0;
let registration: Promise<ServiceWorkerRegistration | null> | null = null;
try {
  const saved = localStorage.getItem(PREFERENCE);
  if (saved !== null) enabled = saved === 'enabled';
} catch {
  // A blocked storage API must not prevent chat from loading.
}

export function notificationsEnabled(): boolean {
  return (
    enabled &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  );
}

export function setNotificationsEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(PREFERENCE, value ? 'enabled' : 'disabled');
  } catch {
    // The preference still applies for the lifetime of this page.
  }
  if (!value) void closePocketNotifications();
}

/** A notification-only child scope; it cannot intercept application requests. */
export function prepareNotificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  if (!registration) {
    registration = (async () => {
      const scope = new URL(
        'pocket-notifications/',
        new URL(APP_BASE, location.origin),
      );
      const reg = await navigator.serviceWorker.register(
        new URL('sw.js', scope).href,
        { scope: scope.href, updateViaCache: 'none' },
      );
      // Do not use serviceWorker.ready: the app deliberately has no controller.
      if (!reg.active) {
        await new Promise<void>((resolve, reject) => {
          const worker = reg.installing ?? reg.waiting;
          if (!worker)
            return reject(new Error('Notification worker unavailable'));
          const timer = setTimeout(
            () => finish(new Error('Notification worker timeout')),
            10000,
          );
          const finish = (error?: Error) => {
            clearTimeout(timer);
            worker.removeEventListener('statechange', check);
            if (error) reject(error);
            else resolve();
          };
          const check = () => {
            if (worker.state === 'activated') finish();
            else if (worker.state === 'redundant')
              finish(new Error('Notification worker replaced'));
          };
          worker.addEventListener('statechange', check);
          check();
        });
      }
      return reg;
    })().catch(() => {
      registration = null;
      return null;
    });
  }
  return registration;
}

/** Call directly from a click so mobile browsers retain user activation. */
export async function enablePocketNotifications(): Promise<
  NotificationPermission | 'unavailable'
> {
  if (!window.isSecureContext || typeof Notification === 'undefined')
    return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setNotificationsEnabled(false);
    return permission;
  }
  setNotificationsEnabled(true);
  await prepareNotificationWorker();
  return permission;
}

export async function closePocketNotifications(): Promise<void> {
  notificationEpoch++;
  await clearVisibleNotifications();
}

async function clearVisibleNotifications(): Promise<void> {
  try {
    const reg = registration ? await registration : null;
    for (const notice of (await reg?.getNotifications()) ?? []) notice.close();
  } catch {
    // Revocation or browser shutdown may make the registration unavailable.
  }
}

/**
 * Page-delivered notifications, not server Web Push. The browser must still
 * be running the page to receive events; a suspended/closed app is not covered.
 * Lock-screen previews deliberately contain no conversation content.
 */
export async function notifyPocketIfHidden(
  test = false,
  body?: string,
): Promise<void> {
  if (!enabled || (!test && !document.hidden)) return;
  if (
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  )
    return;
  const epoch = notificationEpoch;
  const now = Date.now();
  if (!test && now - lastNoticeAt < 1000) return;
  lastNoticeAt = now;
  const title = 'Miniclaw';
  const options: NotificationOptions = {
    body: test ? '通知已启用。' : body || '有新的会话结果，打开查看。',
    tag: 'miniclaw-pocket-activity',
    icon: appNotificationIconUrl,
    data: { url: new URL(withBasePath('/chat'), location.origin).href },
  };
  const reg = await prepareNotificationWorker();
  // Permission or preference may change while the worker starts.
  if (
    epoch !== notificationEpoch ||
    !enabled ||
    Notification.permission !== 'granted' ||
    (!test && !document.hidden)
  )
    return;
  try {
    if (reg) {
      await reg.showNotification(title, options);
      if (epoch !== notificationEpoch) await clearVisibleNotifications();
      return;
    }
  } catch {
    // Desktop fallback below. Some mobile browsers reject the constructor.
  }
  try {
    const notice = new Notification(title, options);
    notice.onclick = () => {
      window.focus();
      notice.close();
    };
  } catch {
    // Unsupported notifications must never interrupt message processing.
  }
}

const onStorage = (event: StorageEvent) => {
  if (event.key !== PREFERENCE) return;
  enabled = event.newValue === 'enabled';
  if (!enabled) void closePocketNotifications();
};
if (typeof window !== 'undefined')
  window.addEventListener('storage', onStorage);
if (import.meta.hot) {
  import.meta.hot.dispose(() =>
    window.removeEventListener('storage', onStorage),
  );
}
