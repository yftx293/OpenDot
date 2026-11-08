import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deletedFolders: [] as string[],
  blocked: [] as string[][],
  unblocked: [] as string[][],
  safetyBlocked: false,
  profiles: new Map<string, any[]>(),
  workspaces: new Map<string, any[]>(),
  sessions: { 'u1-inherit-folder': 'old-session' } as Record<string, string>,
}));

vi.mock('../src/db.js', () => ({
  deleteWorkspaceSessions: (folder: string) =>
    state.deletedFolders.push(folder),
  getAllUsers: () => [
    { id: 'u1', status: 'active' },
    { id: 'u2', status: 'active' },
    { id: 'disabled-user', status: 'disabled' },
  ],
  listAgentProfilesForUser: (userId: string) =>
    state.profiles.get(userId) ?? [],
}));

vi.mock('../src/web-context.js', () => ({
  getWebDeps: () => ({
    sessions: state.sessions,
    queue: {
      blockGroupsForRuntimeSafety: (jids: string[]) => state.blocked.push(jids),
      unblockGroupsForRuntimeSafety: (jids: string[]) =>
        state.unblocked.push(jids),
      isGroupRuntimeSafetyBlocked: () => state.safetyBlocked,
    },
  }),
}));

vi.mock('../src/agent-profile-runtime.js', () => ({
  listWorkspaceGroupsForAgentProfile: (_ownerId: string, profileId: string) =>
    state.workspaces.get(profileId) ?? [],
  getWorkspaceRuntimeJids: (_deps: unknown, folder: string) => [
    `web:${folder}`,
  ],
  quiesceWorkspaceRunnersAroundCommit: async (
    _deps: unknown,
    targets: Array<{ folder: string }>,
    _options: unknown,
    commit: () => Promise<unknown> | unknown,
  ) => ({
    value: await commit(),
    runtimeJids: targets.map((target) => `web:${target.folder}`),
  }),
}));

const runtime = await import('../src/capability-runtime-mutation.js');
const lifecycle =
  await import('../src/personal-agent/mcp-capability-lifecycle.js');

test('native MCP cleanup precedes persistence and resumes original work even after commit failure', async () => {
  const order: string[] = [];
  const remove = lifecycle.registerMcpCapabilityLifecycle(async () => {
    order.push('quiesce');
    return async () => {
      order.push('resume');
    };
  });
  try {
    await expect(
      runtime.mutateCapabilityAroundRuntimeQuiesce(
        { kind: 'mcp', scope: 'user', ownerUserId: 'u1' },
        'fixture',
        () => {
          order.push('commit');
          throw new Error('fixture commit failure');
        },
      ),
    ).rejects.toThrow('fixture commit failure');
    expect(order).toEqual(['quiesce', 'commit', 'resume']);
  } finally {
    remove();
  }
});
test('failed native cleanup prevents the MCP commit; unrelated Skill mutations do not invoke it', async () => {
  const commit = vi.fn();
  const remove = lifecycle.registerMcpCapabilityLifecycle(async () => {
    throw new Error('fixture teardown failure');
  });
  try {
    await expect(
      runtime.mutateCapabilityAroundRuntimeQuiesce(
        { kind: 'mcp', scope: 'user', ownerUserId: 'u1' },
        'fixture',
        commit,
      ),
    ).rejects.toThrow('fixture teardown failure');
    expect(commit).not.toHaveBeenCalled();
    await runtime.mutateCapabilityAroundRuntimeQuiesce(
      { kind: 'skills', ownerUserId: 'u1' },
      'fixture',
      commit,
    );
    expect(commit).toHaveBeenCalledTimes(1);
  } finally {
    remove();
  }
});

function profile(id: string, mcp: { mode: string; ids: string[] }) {
  return {
    id,
    runtime_policy: {
      mcp,
      skills: { mode: 'disabled', ids: [] },
    },
  };
}

function workspace(folder: string) {
  return [{ jid: `web:${folder}`, group: { folder } }];
}

beforeEach(() => {
  state.deletedFolders.length = 0;
  state.blocked.length = 0;
  state.unblocked.length = 0;
  state.safetyBlocked = false;
  state.profiles.clear();
  state.workspaces.clear();
  state.sessions = { 'u1-inherit-folder': 'old-session' };
});

describe('capability runtime mutation invalidation', () => {
  test('system MCP mutation targets every inherit or source-qualified custom Agent', async () => {
    state.profiles.set('u1', [
      profile('u1-inherit', { mode: 'inherit', ids: [] }),
      profile('u1-disabled', { mode: 'disabled', ids: [] }),
    ]);
    state.profiles.set('u2', [
      profile('u2-custom', { mode: 'custom', ids: ['system:platform'] }),
      profile('u2-other', { mode: 'custom', ids: ['system:other'] }),
    ]);
    state.workspaces.set('u1-inherit', workspace('u1-inherit-folder'));
    state.workspaces.set('u1-disabled', workspace('u1-disabled-folder'));
    state.workspaces.set('u2-custom', workspace('u2-custom-folder'));
    state.workspaces.set('u2-other', workspace('u2-other-folder'));

    let committed = false;
    const result = await runtime.mutateCapabilityAroundRuntimeQuiesce(
      {
        kind: 'mcp',
        ownerUserId: 'admin',
        scope: 'system',
        ids: ['platform'],
      },
      'system MCP updated',
      () => {
        committed = true;
      },
    );

    expect(committed).toBe(true);
    expect(state.deletedFolders.sort()).toEqual([
      'u1-inherit-folder',
      'u2-custom-folder',
    ]);
    expect(state.sessions).not.toHaveProperty('u1-inherit-folder');
    expect(state.unblocked).toEqual([
      ['web:u1-inherit-folder', 'web:u2-custom-folder'],
    ]);
    expect(result.invalidatedRuntimeJids).toBe(2);
  });

  test('repairs a prior safety block before a retry can resume work', async () => {
    state.profiles.set('u1', [
      profile('u1-inherit', { mode: 'inherit', ids: [] }),
    ]);
    state.workspaces.set('u1-inherit', workspace('u1-inherit-folder'));
    state.safetyBlocked = true;

    const repaired = await runtime.repairCapabilityRuntimeSafetyBlock(
      {
        kind: 'mcp',
        ownerUserId: 'u1',
        scope: 'user',
        ids: ['private'],
      },
      'retry cleanup',
    );

    expect(repaired).toBe(1);
    expect(state.deletedFolders).toEqual(['u1-inherit-folder']);
    expect(state.unblocked).toEqual([['web:u1-inherit-folder']]);
  });
});
