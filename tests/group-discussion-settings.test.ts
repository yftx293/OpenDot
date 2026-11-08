import { expect, test } from 'vitest';
import { buildDiscussionSettings } from '../web/src/features/bot-groups/discussion-settings.js';
import type { BotGroupSnapshot } from '../src/bot-groups/types.js';
const snapshot = {
  revision: 7,
  members: ['a', 'b'].map((subject_id) => ({
    kind: 'bot',
    state: 'active',
    available: true,
    subject_id,
  })),
  discussion: { settings: null, run: null },
} as unknown as BotGroupSnapshot;
test('first explicit enable chooses relay without needing an advanced-settings visit', () => {
  const body = buildDiscussionSettings(snapshot, { enabled: true });
  expect(body).toMatchObject({
    enabled: true,
    policy: 'relay-v1',
    coordinator_profile_id: 'a',
    participant_profile_ids: ['a', 'b'],
    expected_revision: 7,
  });
});

const saved = {
  enabled: false,
  policy: 'coordinator-v1' as const,
  coordinator_profile_id: 'b',
  participant_profile_ids: ['b'],
  max_turns: 9,
  max_turns_per_dot: 3,
  max_model_attempts: 12,
};
test('re-enabling preserves saved policy, participants and budget and never mutates an active Run', () => {
  const state = {
    ...snapshot,
    discussion: {
      settings: saved,
      run: { id: 'run', policy: 'coordinator-v1', protocol_version: 1 },
    },
  } as BotGroupSnapshot;
  const before = JSON.stringify(state);
  expect(buildDiscussionSettings(state, { enabled: true })).toEqual({
    ...saved,
    enabled: true,
    expected_revision: 7,
  });
  expect(
    buildDiscussionSettings(state, { enabled: true, policy: 'relay-v1' })
      .policy,
  ).toBe('relay-v1');
  expect(JSON.stringify(state)).toBe(before);
});
test('only active available roster IDs survive, deduplicated, without an external default Dot', () => {
  const state = {
    ...snapshot,
    members: [
      ...snapshot.members,
      { ...snapshot.members[0], subject_id: 'disabled', state: 'disabled' },
      { ...snapshot.members[0], subject_id: 'removed', state: 'removed' },
      { ...snapshot.members[0], subject_id: 'unavailable', available: false },
    ],
    discussion: {
      settings: {
        ...saved,
        coordinator_profile_id: 'removed',
        participant_profile_ids: [
          'a',
          'a',
          'removed',
          'disabled',
          'unavailable',
          'foreign',
        ],
      },
      run: null,
    },
  } as BotGroupSnapshot;
  const body = buildDiscussionSettings(state, { enabled: true });
  expect(body.coordinator_profile_id).toBe('a');
  expect(body.participant_profile_ids).toEqual(['a']);
  expect(body.policy).toBe('coordinator-v1');
  expect(body.expected_revision).toBe(state.revision);
});
test('empty rosters do not invent a coordinator and new settings do not enable discussion by reading them', () => {
  const empty = buildDiscussionSettings({ ...snapshot, members: [] });
  expect(empty.enabled).toBe(false);
  expect(empty.coordinator_profile_id).toBe('');
  expect(empty.participant_profile_ids).toEqual([]);
});

test('saved valid IDs beyond the first eight roster entries stay valid; only the participant count is bounded', () => {
  const members = Array.from({ length: 10 }, (_, i) => ({
    ...snapshot.members[0],
    subject_id: 'dot-' + i,
  }));
  const state = {
    ...snapshot,
    members,
    discussion: {
      settings: {
        ...saved,
        coordinator_profile_id: 'dot-9',
        participant_profile_ids: ['dot-9'],
      },
      run: null,
    },
  } as BotGroupSnapshot;
  expect(buildDiscussionSettings(state).coordinator_profile_id).toBe('dot-9');
  expect(buildDiscussionSettings(state).participant_profile_ids).toEqual([
    'dot-9',
  ]);
  expect(
    buildDiscussionSettings({ ...snapshot, members }).participant_profile_ids,
  ).toHaveLength(8);
});

test('bounded multi-member opt-in defaults allow two questions and a final while preserving an explicit saved limit', () => {
  const state = {
    ...snapshot,
    discussion: { settings: null, run: null, member_inbox_max_participants: 8 },
  } as BotGroupSnapshot;
  expect(
    buildDiscussionSettings(state, { execution_contract: 'member-inbox-v1' })
      .max_turns_per_dot,
  ).toBe(3);
  expect(
    buildDiscussionSettings(state, { execution_contract: 'serial-v1' })
      .max_turns_per_dot,
  ).toBe(2);
  expect(
    buildDiscussionSettings(
      {
        ...state,
        discussion: {
          ...state.discussion!,
          settings: { ...saved, max_turns_per_dot: 1 },
        },
      },
      { execution_contract: 'member-inbox-v1' },
    ).max_turns_per_dot,
  ).toBe(1);
});
