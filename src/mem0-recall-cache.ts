import { createHash } from 'node:crypto';
import type { Mem0PrivateScope, Mem0SearchHit } from './mem0-private-client.js';

// Process-local, short-lived and bounded. Scope and query never appear in a
// cache key as plaintext. Frozen input snapshots remain the recovery authority.
const entries = new Map<string, { expires: number; hits: Mem0SearchHit[] }>();
const pending = new Map<string, Promise<Mem0SearchHit[]>>();
let epoch = 0;
const limit = 128;
const ttl = 15_000;

export function clearMem0RecallCache() {
  epoch++;
  entries.clear();
  pending.clear();
}

export async function cachedMem0Search(
  input: {
    ownerId: string;
    profileId: string;
    credentialVersion: number;
    policyVersion: number;
    scope: Mem0PrivateScope;
    query: string;
    topK: number;
  },
  search: () => Promise<Mem0SearchHit[]>,
  onAccess?: (kind: 'hit' | 'shared' | 'miss') => void,
): Promise<Mem0SearchHit[]> {
  const note = (kind: 'hit' | 'shared' | 'miss') => {
    try {
      onAccess?.(kind);
    } catch {
      /* Metrics cannot alter recall. */
    }
  };
  const key = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const now = Date.now();
  for (const [id, entry] of entries)
    if (entry.expires <= now) entries.delete(id);
  const found = entries.get(key);
  if (found) {
    note('hit');
    return found.hits.map((hit) => ({ ...hit }));
  }
  let work = pending.get(key);
  note(work ? 'shared' : 'miss');
  if (!work) {
    if (pending.size >= limit)
      return (await search()).map((hit) => ({ ...hit }));
    const generation = epoch;
    work = (async () => {
      const hits = await search();
      if (epoch === generation) {
        while (entries.size >= limit)
          entries.delete(entries.keys().next().value!);
        const entry = {
          expires: Date.now() + ttl,
          hits: hits.map((hit) => ({ ...hit })),
        };
        entries.set(key, entry);
        const timer = setTimeout(() => {
          if (entries.get(key) === entry) entries.delete(key);
        }, ttl);
        timer.unref?.();
      }
      return hits;
    })();
    pending.set(key, work);
    void work
      .finally(() => {
        if (pending.get(key) === work) pending.delete(key);
      })
      .catch(() => {});
  }
  return (await work).map((hit) => ({ ...hit }));
}
