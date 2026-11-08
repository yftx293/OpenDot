import { expect, test, vi } from 'vitest';
import {
  cachedMem0Search,
  clearMem0RecallCache,
} from '../src/mem0-recall-cache.js';

const request = {
  ownerId: 'owner-a',
  profileId: 'dot-a',
  credentialVersion: 1,
  policyVersion: 1,
  scope: { app_id: 'app', user_id: 'user', agent_id: 'agent', run_id: 'run' },
  query: 'private query',
  topK: 5,
};
const hits = [{ id: '1', memory: 'private result', score: 0.8 }];

test('concurrent matching searches share work but owner and version boundaries do not', async () => {
  clearMem0RecallCache();
  const fetch = vi.fn(async () => hits);
  const [one, two] = await Promise.all([
    cachedMem0Search(request, fetch),
    cachedMem0Search(request, fetch),
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(one).toEqual(two);
  expect(one).not.toBe(two);
  await cachedMem0Search({ ...request, ownerId: 'owner-b' }, fetch);
  await cachedMem0Search({ ...request, credentialVersion: 2 }, fetch);
  await cachedMem0Search({ ...request, policyVersion: 2 }, fetch);
  await cachedMem0Search(
    { ...request, scope: { ...request.scope, run_id: 'other' } },
    fetch,
  );
  expect(fetch).toHaveBeenCalledTimes(5);
  clearMem0RecallCache();
});

test('invalidation fences an old in-flight result and failures are not cached', async () => {
  clearMem0RecallCache();
  let finish!: (value: typeof hits) => void;
  const old = cachedMem0Search(
    request,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  clearMem0RecallCache();
  finish(hits);
  await old;
  const fetch = vi.fn(async () => hits);
  await cachedMem0Search(request, fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  clearMem0RecallCache();
  const fail = vi.fn(async () => {
    throw new Error('unavailable');
  });
  await expect(cachedMem0Search(request, fail)).rejects.toThrow('unavailable');
  await expect(cachedMem0Search(request, fail)).rejects.toThrow('unavailable');
  expect(fail).toHaveBeenCalledTimes(2);
  clearMem0RecallCache();
});
