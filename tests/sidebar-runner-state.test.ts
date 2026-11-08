import { expect, test } from 'vitest';

import { useGroupsStore } from '../web/src/stores/groups.ts';

test('reconnect snapshots clear workspace dots whose run disappeared', () => {
  const store = useGroupsStore.getState();
  store.reconcileRunnerStates(['web:one', 'web:two']);
  expect(useGroupsStore.getState().runnerStates).toEqual({
    'web:one': 'running',
    'web:two': 'running',
  });

  // The crashed/vanished run is no longer in the authoritative snapshot.
  store.reconcileRunnerStates(['web:two']);
  expect(useGroupsStore.getState().runnerStates).toEqual({
    'web:two': 'running',
  });

  store.setRunnerState('web:two', 'idle');
  expect(useGroupsStore.getState().runnerStates).toEqual({});
});

test('agent virtual JIDs never own a workspace sidebar dot', () => {
  useGroupsStore.getState().reconcileRunnerStates(['web:one#agent:abc']);
  expect(useGroupsStore.getState().runnerStates).toEqual({});
});
