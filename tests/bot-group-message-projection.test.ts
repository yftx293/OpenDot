import { expect, test } from 'vitest';
import { botGroupMessageType } from '../src/bot-groups/message-projection.js';

test('legacy bot system_event replies project as conversations without rewriting their receipt metadata', () => {
  const source = Object.freeze({
    kind: 'group_discussion_reply',
    result_digest: 'original',
    protocol_version: 1,
  });
  const row = Object.freeze({
    kind: 'system_event' as const,
    author_kind: 'bot' as const,
    source,
  });
  expect(botGroupMessageType(row)).toBe('conversation');
  expect(row.kind).toBe('system_event');
  expect(row.source).toBe(source);
  expect(row.source.result_digest).toBe('original');
  expect(
    botGroupMessageType({ ...row, source: { kind: 'older_public_reply' } }),
  ).toBe('conversation');
  expect(
    botGroupMessageType({ ...row, source: { kind: 'native_handoff_result' } }),
  ).toBe('conversation');
});
test('status events stay separate from conversation content and cannot impersonate a Dot by source alone', () => {
  expect(
    botGroupMessageType({
      kind: 'system_event',
      author_kind: 'system',
      source: { kind: 'group_discussion_reply' },
    }),
  ).toBe('status');
  expect(
    botGroupMessageType({
      kind: 'system_event',
      author_kind: 'bot',
      source: { kind: 'native_handoff_fence' },
    }),
  ).toBe('status');
  expect(
    botGroupMessageType({
      kind: 'user_message',
      author_kind: 'user',
      source: {},
    }),
  ).toBe('conversation');
});
