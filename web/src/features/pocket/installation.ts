interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let pending: InstallEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

const beforeInstall = (event: Event) => {
  event.preventDefault();
  pending = event as InstallEvent;
  changed();
};
const installed = () => {
  pending = null;
  changed();
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', beforeInstall);
  window.addEventListener('appinstalled', installed);
}

export const canInstall = (): boolean => pending !== null;
export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function installPocket(): Promise<string> {
  const event = pending;
  if (!event) return 'unavailable';
  pending = null;
  changed();
  await event.prompt();
  return (await event.userChoice).outcome;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeinstallprompt', beforeInstall);
    window.removeEventListener('appinstalled', installed);
    listeners.clear();
  });
}
