export type DurableMainRedirect = { jid: string; agentId: string };

let current: DurableMainRedirect | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setDurableMainRedirect(value: DurableMainRedirect) {
  current = value;
  emit();
}

export function clearDurableMainRedirect() {
  if (!current) return;
  current = null;
  emit();
}

export function getDurableMainRedirect() {
  return current;
}

export function subscribeDurableMainRedirect(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
