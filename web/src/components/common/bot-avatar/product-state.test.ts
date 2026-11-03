import { describe, expect, test } from 'vitest';
import {
  activityAvatarState,
  botWorkAvatarState,
  handoffAvatarState,
  profileIdentity,
  mainWorkspaceForBot,
} from './product-state';
import type { BotHandoffView } from '../../../../../src/bot-groups/handoff-types';

const task = (
  id: string,
  state: BotHandoffView['state'],
  extra = {},
): BotHandoffView =>
  ({
    id,
    state,
    target_bot_id: 'researcher',
    goal_id: 'goal-a',
    updated_at: '2026-10-20T00:00:00Z',
    revision: 1,
    ...extra,
  }) as BotHandoffView;

describe('product avatar authority', () => {
  test('stale snapshots settle without presenting work or completion', () => {
    expect(handoffAvatarState(task('a', 'running'), false)).toBe('waiting');
    expect(activityAvatarState('completed', false)).toBe('waiting');
    expect(activityAvatarState('running', true, true)).toBe('waiting');
    expect(activityAvatarState('unexpected', true)).toBe('idle');
  });
  test('committed recovery settles instead of claiming working or thinking', () => {
    expect(
      handoffAvatarState(
        task('a', 'running', {
          progress: JSON.stringify({ cloud_runtime_state: 'recovering' }),
        }),
      ),
    ).toBe('waiting');
    expect(
      handoffAvatarState(task('a', 'running', { progress: 'invalid' })),
    ).toBe('working');
    expect(
      handoffAvatarState(
        task('a', 'completed', {
          progress: JSON.stringify({ cloud_runtime_state: 'recovering' }),
        }),
      ),
    ).toBe('completed');
  });
  test('each Bot and Goal uses its own work rather than aggregate Goal or other Bot activity', () => {
    const tasks = [
      task('a', 'running'),
      task('b', 'waiting_for_device', { target_bot_id: 'developer' }),
      task('c', 'failed', {
        goal_id: 'goal-b',
        updated_at: '2026-10-20T01:00:00Z',
      }),
    ];
    expect(botWorkAvatarState(tasks, 'researcher', true, 'goal-a')).toBe(
      'working',
    );
    expect(botWorkAvatarState(tasks, 'developer', true, 'goal-a')).toBe(
      'waiting',
    );
    expect(botWorkAvatarState(tasks, 'chief', true, 'goal-a')).toBe('idle');
    expect(botWorkAvatarState(tasks, 'researcher', true, 'goal-b')).toBe(
      'error',
    );
    expect(botWorkAvatarState(tasks, 'researcher', false, 'goal-a')).toBe(
      'waiting',
    );
  });
  test('unfinished work takes precedence over a newer completed parallel task; input arrays are untouched', () => {
    const tasks = [
      task('done', 'completed', { updated_at: '2026-10-20T01:00:00Z' }),
      task('running', 'running'),
    ];
    expect(botWorkAvatarState(tasks, 'researcher', true)).toBe('working');
    expect(tasks[0].id).toBe('done');
    expect(
      botWorkAvatarState([task('uncertain', 'uncertain')], 'researcher', true),
    ).toBe('attention');
  });
  test('Profile identity preserves customization and uses the Profile ID independently of the display name', () => {
    expect(
      profileIdentity({
        id: 'stable',
        name: 'Renamed',
        is_default: true,
        avatar_emoji: '🐙',
        avatar_color: '#abc',
        avatar_url: '/api/auth/avatars/custom.png',
      }),
    ).toEqual({
      profile_id: 'stable',
      name: 'Renamed',
      avatar_emoji: '🐙',
      avatar_color: '#abc',
      avatar_url: '/api/auth/avatars/custom.png',
    });
  });
});

test('only the exact main run is attributed to the Workspace Bot; child conversations have independent identities', () => {
  const groups = {
    'web:project': {
      name: 'Project',
      folder: 'project',
      added_at: '2026-10-20',
      agent_profile_id: 'researcher',
      interaction_mode: 'assistant' as const,
    },
  };
  const run = {
    chatJid: 'web:project',
    runId: 'run-1',
    startedAt: '2026-10-20',
    phase: 'running' as const,
  };
  expect(
    mainWorkspaceForBot('researcher', groups, {
      'web:project#agent:developer': {
        ...run,
        chatJid: 'web:project#agent:developer',
      },
    }),
  ).toBeUndefined();
  expect(
    mainWorkspaceForBot('researcher', groups, { 'web:project': run })?.[0],
  ).toBe('web:project');
  expect(
    mainWorkspaceForBot('developer', groups, { 'web:project': run }),
  ).toBeUndefined();
});
