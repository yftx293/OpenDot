import { describe, expect, test } from 'vitest';
import { chooseBotWorkspace } from '../web/src/utils/bot-entry.js';
import type { AgentProfile, GroupInfo } from '../web/src/types.js';

const profile = (id: string, is_default = false) =>
  ({ id, is_default }) as AgentProfile;
const group = (folder: string, extras: Partial<GroupInfo> = {}) =>
  ({ folder, ...extras }) as GroupInfo;

describe('Bot-first routing preserves workspace authorization boundary', () => {
  const groups: Record<string, GroupInfo> = {
    'web:chief': group('chief', {
      is_my_home: true,
      agent_profile_id: 'chief',
    }),
    'web:other': group('other', { agent_profile_id: 'research' }),
  };
  test('Chief resolves only the existing personal home', () => {
    expect(chooseBotWorkspace(profile('chief', true), groups)?.jid).toBe(
      'web:chief',
    );
  });
  test('professional Bot opens only its existing profile-linked workspace', () => {
    expect(chooseBotWorkspace(profile('research'), groups)?.jid).toBe(
      'web:other',
    );
  });
  test('an unbound Bot cannot silently create or take over a workspace', () => {
    expect(chooseBotWorkspace(profile('unknown'), groups)).toBeNull();
  });
  test('empty account returns no guessed route', () => {
    expect(chooseBotWorkspace(profile('chief', true), {})).toBeNull();
  });
  test('matching IM and stale Home metadata cannot become a Bot private entry', () => {
    expect(
      chooseBotWorkspace(profile('research'), {
        'telegram:123': group('other', { agent_profile_id: 'research' }),
      }),
    ).toBeNull();
    expect(
      chooseBotWorkspace(profile('chief', true), {
        'web:home': group('home', {
          is_my_home: true,
          agent_profile_id: 'another-profile',
        }),
      }),
    ).toBeNull();
  });
});
