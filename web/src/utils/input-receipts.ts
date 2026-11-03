// Unknown input outcomes retain their key until acknowledged. No timeout may
// silently turn an uncertain request into a fresh execution. Only hashes/IDs
// are stored here; drafts and credentials are not copied into this journal.
const memory = new Map<string, Record<string, string>>();
const prefix = 'miniclaw:input-receipts:';
function read(owner: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(prefix + owner) ?? '{}',
    );
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.fromEntries(
        Object.entries(parsed).filter(
          ([key, value]) =>
            /^[a-f0-9]{64}$/.test(key) &&
            typeof value === 'string' &&
            /^[a-f0-9-]{36}$/i.test(value),
        ),
      );
      memory.set(owner, entries);
      return entries;
    }
  } catch {
    /* Storage unavailable: preserve this page's pending receipts. */
  }
  return memory.get(owner) ?? {};
}
function write(owner: string, entries: Record<string, string>) {
  memory.set(owner, entries);
  try {
    localStorage.setItem(prefix + owner, JSON.stringify(entries));
  } catch {
    /* Memory retains the receipt for this page. */
  }
}
export async function pendingInputRequest(owner: string, payload: unknown) {
  if (!owner) throw new Error('Authenticated input owner is required');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const scope = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  const entries = read(owner);
  if (!entries[scope]) {
    if (Object.keys(entries).length >= 500)
      throw new Error(
        'Too many unconfirmed inputs; reconcile existing receipts before submitting more',
      );
    entries[scope] = crypto.randomUUID();
    write(owner, entries);
  }
  const requestId = entries[scope];
  return {
    requestId,
    acknowledge: () => {
      const current = read(owner);
      if (current[scope] !== requestId) return;
      delete current[scope];
      write(owner, current);
    },
  };
}
