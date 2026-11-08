import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  boundedDiscussionText,
  DISCUSSION_INPUT_BYTES,
  freezeDiscussionContext,
} from '../src/bot-groups/discussion-context.js';
import { discussionOutputContract } from '../src/bot-groups/discussion-protocol.js';

function message(seq: number, content: string, since = true) {
  return {
    id: `message-${seq}`,
    seq,
    author: 'Researcher',
    author_kind: 'bot',
    content,
    truncated: false,
    omitted_characters: 0,
    since_last_read: since,
  };
}
function selection() {
  return {
    through: 12,
    context: {
      kind: 'group_discussion_context',
      context_version: 2,
      run_id: 'run',
      policy: 'relay-v1',
      root_question: {
        id: 'root',
        content: 'Choose a migration strategy.',
        truncated: false,
        omitted_characters: 0,
      },
      earlier_root: {
        run_id: 'earlier',
        status: 'completed',
        root: 'Earlier background.',
        truncated: false,
        omitted_characters: 0,
      },
      recent_and_delta: [
        message(2, 'Known background.', false),
        message(11, 'A dynamically committed fact.'),
      ],
      user_interjections: [message(12, 'Keep the existing receipts.')],
      unread_ids: ['message-11', 'message-12'],
      user_interjection_ids: ['message-12'],
      canonical_through_seq: 12,
      last_read_seq: 10,
      omitted_unread_ranges: [] as { from_seq: number; through_seq: number }[],
      history_truncated: false,
      context_digest: 'old digest',
    },
  };
}
function contract() {
  return {
    role: 'speaker',
    protocol_version: 2,
    output_schema: discussionOutputContract('speaker', 2, true),
    work_return: {
      work_id: 'work',
      originating_turn_id: 'origin',
      instruction: 'Inspect the actual result.',
      result_message_id: 'native-result',
      result_digest: 'a'.repeat(64),
      public_result: 'Actual native result: ' + 'f'.repeat(64),
      truncated: false,
      omitted_characters: 0,
    },
  };
}
test('freezes deterministic exact bytes without changing the selection or contract', () => {
  const input = selection(),
    control = contract();
  const before = structuredClone({ input, control });
  const frozen = freezeDiscussionContext(input, control);
  const parsed = JSON.parse(frozen.content);
  expect(frozen).toEqual(freezeDiscussionContext(input, control));
  expect({ input, control }).toEqual(before);
  expect(frozen.through).toBe(12);
  expect(parsed.read_through_seq).toBe(12);
  expect(parsed.recent_and_delta).toEqual(input.context.recent_and_delta);
  expect(parsed.speaker_contract).toEqual(control);
  const {
    context_digest: digest,
    speaker_contract: ignored,
    ...source
  } = parsed;
  expect(digest).toBe(
    createHash('sha256').update(JSON.stringify(source)).digest('hex'),
  );
});

test('budgets the full UTF-8 envelope and prioritizes fresh instructions and the real work result', () => {
  const input = selection(),
    control = contract();
  input.context.root_question.content = '当前问题：' + '迁移🧪'.repeat(550);
  input.context.earlier_root!.root = '过去背景'.repeat(900);
  input.context.recent_and_delta = [
    ...Array.from({ length: 8 }, (_, i) =>
      message(i + 1, '旧背景🧪'.repeat(500), false),
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      message(i + 11, '成员发言🧪'.repeat(500)),
    ),
  ];
  input.context.user_interjections = [
    message(19, '不要部署，保留回执。🧪'.repeat(45)),
  ];
  input.context.user_interjection_ids = ['message-19'];
  input.context.unread_ids = Array.from(
    { length: 9 },
    (_, i) => `message-${i + 11}`,
  );
  input.through = input.context.canonical_through_seq = 19;
  control.work_return.instruction = '独立任务🧪'.repeat(900);
  control.work_return.public_result = '真实原生产物🧪'.repeat(120);
  const publicResult = control.work_return.public_result;
  const original = structuredClone({ input, control });
  const frozen = freezeDiscussionContext(input, control);
  const parsed = JSON.parse(frozen.content);
  expect(Buffer.byteLength(frozen.content, 'utf8')).toBeLessThanOrEqual(
    DISCUSSION_INPUT_BYTES,
  );
  expect(
    parsed.recent_and_delta.every(
      (m: { since_last_read: boolean }) => m.since_last_read,
    ),
  ).toBe(true);
  expect(parsed.omitted_history_ranges).toEqual([
    { from_seq: 1, through_seq: 8 },
  ]);
  expect(parsed.root_question.content).toBe(
    input.context.root_question.content,
  );
  expect(parsed.user_interjections).toEqual(input.context.user_interjections);
  expect(parsed.speaker_contract.work_return.public_result).toBe(publicResult);
  expect(parsed.speaker_contract.work_return.result_message_id).toBe(
    'native-result',
  );
  expect(parsed.speaker_contract.work_return.result_digest).toBe(
    'a'.repeat(64),
  );
  expect(parsed.speaker_contract.work_return.instruction_truncated).toBe(true);
  expect(
    parsed.speaker_contract.work_return.instruction_omitted_characters +
      parsed.speaker_contract.work_return.instruction.length,
  ).toBe(control.work_return.instruction.length);
  for (const m of parsed.recent_and_delta) {
    const prior = input.context.recent_and_delta.find(
      (row) => row.id === m.id,
    )!;
    expect(m.omitted_characters + m.content.length).toBe(prior.content.length);
    expect(prior.content.startsWith(m.content)).toBe(true);
  }
  expect(frozen.through).toBe(19); // Truncated text is explicit; no whole unread message was dropped.
  expect({ input, control }).toEqual(original);
});

test('metadata-heavy unread omission keeps the cursor before the first missing message', () => {
  const input = selection(),
    control = contract();
  input.context.recent_and_delta = Array.from({ length: 4 }, (_, i) => ({
    ...message(i + 11, 'x'.repeat(1800)),
    author: 'Name'.repeat(550),
  }));
  input.context.user_interjections = [message(15, 'Newest owner constraint.')];
  input.context.user_interjection_ids = ['message-15'];
  input.context.unread_ids = Array.from(
    { length: 5 },
    (_, i) => `message-${i + 11}`,
  );
  input.through = input.context.canonical_through_seq = 15;
  const frozen = freezeDiscussionContext(input, control, 9000);
  const parsed = JSON.parse(frozen.content);
  expect(Buffer.byteLength(frozen.content)).toBeLessThanOrEqual(9000);
  const omitted = input.context.recent_and_delta.filter(
    (m) => !parsed.unread_ids.includes(m.id),
  );
  expect(omitted.length).toBeGreaterThan(0);
  expect(frozen.through).toBe(Math.min(...omitted.map((m) => m.seq)) - 1);
  expect(frozen.through).toBeGreaterThanOrEqual(input.context.last_read_seq);
  expect(parsed.omitted_unread_ranges[0].from_seq).toBe(frozen.through + 1);
  expect(parsed.omitted_unread_ranges[0].through_seq).toBe(15);
  expect(parsed.user_interjections[0].content).toBe('Newest owner constraint.');
  expect(parsed.unread_ids).toContain('message-15');
});

test('preserves cumulative omission counts and does not split surrogate pairs or JSON escapes', () => {
  const original = '🧪\n\t"\\中文'.repeat(1000);
  for (const budget of [2, 5, 128, 512, 4000]) {
    const prefix = boundedDiscussionText(original, budget);
    expect(Buffer.byteLength(JSON.stringify(prefix))).toBeLessThanOrEqual(
      budget,
    );
    expect(original.startsWith(prefix)).toBe(true);
    expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/);
  }
  const input = selection();
  input.context.root_question = {
    id: 'root',
    content: original,
    truncated: true,
    omitted_characters: 700,
  };
  const result = JSON.parse(
    freezeDiscussionContext(input, contract(), 8000).content,
  );
  expect(
    result.root_question.omitted_characters +
      result.root_question.content.length,
  ).toBe(original.length + 700);
});

test('fails closed when authority metadata alone cannot fit, without mutating input', () => {
  const input = selection();
  const control = {
    ...contract(),
    eligible_relays: ['untrimmable identity'.repeat(3000)],
  };
  const before = structuredClone(input);
  expect(() => freezeDiscussionContext(input, control)).toThrow(
    'GROUP_DISCUSSION_CONTEXT_TOO_LARGE',
  );
  expect(input).toEqual(before);
});
