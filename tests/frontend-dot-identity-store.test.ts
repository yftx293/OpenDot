import type { AgentProfile } from '../web/src/types';
import { beforeEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({
  owner: 'owner-a' as string | null,
  get: vi.fn(),
  patch: vi.fn(),
}));
vi.mock('../web/src/api/client', () => ({
  api: { get: state.get, patch: state.patch },
  apiFetch: vi.fn(),
}));
vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({ user: state.owner ? { id: state.owner } : null }),
  },
}));
vi.mock('../web/src/stores/chat', () => ({
  useChatStore: { getState: () => ({ loadGroups: async () => {} }) },
}));
vi.mock('../web/src/stores/groups', () => ({
  useGroupsStore: { getState: () => ({ loadGroups: async () => {} }) },
}));
import { useAgentProfilesStore } from '../web/src/stores/agent-profiles';
function result(owner: string, name: string) {
  return {
    profiles: [
      {
        id: owner + '-dot',
        owner_user_id: owner,
        is_default: true,
        name,
        status: 'active',
        version: 1,
      } as AgentProfile,
    ],
    model_configs: [{ id: owner + '-provider' }],
    default_model_config_id: owner + '-provider',
  };
}
beforeEach(() => {
  state.owner = 'owner-a';
  state.get.mockReset();
  state.patch.mockReset();
  useAgentProfilesStore.setState({
    profiles: [],
    modelConfigs: [],
    defaultModelConfigId: null,
  });
});
test('a delayed previous-account response cannot replace the new account Dot or Provider metadata', async () => {
  let resolve!: (value: ReturnType<typeof result>) => void;
  state.get.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const previous = useAgentProfilesStore.getState().loadProfiles();
  state.owner = 'owner-b';
  state.get.mockResolvedValueOnce(result('owner-b', '研究搭子'));
  await useAgentProfilesStore.getState().loadProfiles();
  resolve(result('owner-a', 'Private old Dot'));
  await previous;
  expect(useAgentProfilesStore.getState().profiles.map((p) => p.name)).toEqual([
    '研究搭子',
  ]);
  expect(useAgentProfilesStore.getState().defaultModelConfigId).toBe(
    'owner-b-provider',
  );
  expect(
    useAgentProfilesStore.getState().modelConfigs.map((value) => value.id),
  ).toEqual(['owner-b-provider']);
});
test('an older read cannot roll a renamed Dot back to its previous display name', async () => {
  let resolve!: (value: ReturnType<typeof result>) => void;
  state.get.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const previous = useAgentProfilesStore.getState().loadProfiles();
  state.get.mockResolvedValueOnce(result('owner-a', '小点'));
  await useAgentProfilesStore.getState().loadProfiles();
  resolve(result('owner-a', 'Old name'));
  await previous;
  expect(useAgentProfilesStore.getState().profiles[0].name).toBe('小点');
});

test('a read started before a committed rename cannot overwrite the higher server Profile version', async () => {
  const old = result('owner-a', 'Old name');
  const committed = { ...old.profiles[0], name: '小点', version: 2 };
  let resolve!: (value: unknown) => void;
  state.get.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = useAgentProfilesStore.getState().loadProfiles();
  state.patch.mockResolvedValueOnce({ profile: committed });
  useAgentProfilesStore.setState({
    profiles: [{ ...old.profiles[0], version: 1 }],
  });
  await useAgentProfilesStore
    .getState()
    .updateProfile(committed.id, { name: '小点' });
  resolve({ ...old, profiles: [{ ...old.profiles[0], version: 1 }] });
  await pending;
  expect(useAgentProfilesStore.getState().profiles[0]).toMatchObject({
    name: '小点',
    version: 2,
  });
});
