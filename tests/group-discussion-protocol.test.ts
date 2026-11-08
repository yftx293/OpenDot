import { expect, test } from 'vitest';
import {
  discussionOutputContract,
  parseDiscussionDecision,
  readFrozenDiscussionContract,
} from '../src/bot-groups/discussion-protocol.js';

const peer = '11111111-1111-4111-8111-111111111111';
const wire = (
  control: Record<string, unknown>,
  public_message: string | null,
) => JSON.stringify({ version: 2, public_message, control });

test('v2 separates natural public text from role-scoped control and normalizes all valid decisions', () => {
  expect(
    parseDiscussionDecision(
      wire(
        { action: 'reply', relay_to: peer },
        'I disagree: use the existing queue.',
      ),
      'speaker',
      2,
    ),
  ).toEqual({
    action: 'reply',
    message: 'I disagree: use the existing queue.',
    relay_to: peer,
  });
  expect(
    parseDiscussionDecision(
      wire({ action: 'pass', reason: 'No new information' }, null),
      'speaker',
      2,
    ),
  ).toEqual({ action: 'pass', reason: 'No new information' });
  expect(
    parseDiscussionDecision(
      wire({ action: 'speak', profileId: peer }, null),
      'coordinator',
      2,
    ),
  ).toEqual({ action: 'speak', profileId: peer });
  expect(
    parseDiscussionDecision(
      wire({ action: 'finish' }, 'Use one ordered queue.'),
      'coordinator',
      2,
    ),
  ).toEqual({ action: 'finish', summary: 'Use one ordered queue.' });
  expect(
    parseDiscussionDecision(
      wire({ action: 'wait_for_user' }, 'What is the budget?'),
      'coordinator',
      2,
    ),
  ).toEqual({ action: 'wait_for_user', question: 'What is the budget?' });
});

test('wire versions are explicit and never silently upgrade or downgrade', () => {
  const old = JSON.stringify({
    action: 'reply',
    message: 'Legacy public text',
  });
  expect(parseDiscussionDecision(old, 'speaker')).toEqual({
    action: 'reply',
    message: 'Legacy public text',
  });
  expect(() => parseDiscussionDecision(old, 'speaker', 2)).toThrow(
    'GROUP_DISCUSSION_INVALID_DECISION',
  );
  expect(() =>
    parseDiscussionDecision(
      wire({ action: 'reply' }, 'New text'),
      'speaker',
      1,
    ),
  ).toThrow('GROUP_DISCUSSION_INVALID_DECISION');
  expect(() =>
    parseDiscussionDecision(
      wire({ action: 'reply' }, 'New text').replace(
        '"version":2',
        '"version":3',
      ),
      'speaker',
      2,
    ),
  ).toThrow('GROUP_DISCUSSION_INVALID_DECISION');
});

test('v2 rejects mismatched public/control actions, wrong roles and forged authority', () => {
  for (const text of [
    wire({ action: 'pass' }, 'A disguised reply'),
    wire({ action: 'reply' }, null),
    wire({ action: 'reply' }, '   '),
    wire({ action: 'finish' }, null),
    wire({ action: 'speak', profileId: peer }, 'Hidden public command'),
    wire({ action: 'reply', grant: 'all' }, 'Text'),
    JSON.stringify({
      version: 2,
      public_message: 'Text',
      control: { action: 'reply' },
      tools: ['shell'],
    }),
    'I am done.',
  ])
    expect(() => parseDiscussionDecision(text, 'speaker', 2)).toThrow(
      'GROUP_DISCUSSION_INVALID_DECISION',
    );
  expect(() =>
    parseDiscussionDecision(
      wire({ action: 'speak', profileId: peer }, null),
      'speaker',
      2,
    ),
  ).toThrow('GROUP_DISCUSSION_INVALID_DECISION');
  expect(() =>
    parseDiscussionDecision(
      wire({ action: 'reply' }, 'Text'),
      'coordinator',
      2,
    ),
  ).toThrow('GROUP_DISCUSSION_INVALID_DECISION');
});

test('native settlement reads the exact frozen version; pre-versioned payloads remain v1', () => {
  const frozen = (version?: number) =>
    JSON.stringify({
      content: JSON.stringify({
        canonical_through_seq: 42,
        speaker_contract: {
          role: 'speaker',
          ...(version === undefined ? {} : { protocol_version: version }),
        },
      }),
    });
  expect(readFrozenDiscussionContract(frozen())).toEqual({
    role: 'speaker',
    version: 1,
    canonicalThroughSeq: 42,
  });
  expect(readFrozenDiscussionContract(frozen(2))).toEqual({
    role: 'speaker',
    version: 2,
    canonicalThroughSeq: 42,
  });
  expect(() => readFrozenDiscussionContract(frozen(3))).toThrow(
    'GROUP_DISCUSSION_INPUT_MISMATCH',
  );
  expect(() => readFrozenDiscussionContract('{}')).toThrow(
    'GROUP_DISCUSSION_INPUT_MISMATCH',
  );
});
test('a v2 speaker may only propose bounded independently reviewed work, never grant tools or device authority', () => {
  const work = {
    target_profile_id: peer,
    instruction: 'Review public material.',
    tool_capabilities: ['inspect_text'],
    max_model_attempts: 2,
  };
  expect(
    parseDiscussionDecision(
      wire({ action: 'delegate', work }, 'Owner confirmation is required.'),
      'speaker',
      2,
    ),
  ).toEqual({
    action: 'delegate',
    message: 'Owner confirmation is required.',
    work: { ...work, context_message_ids: [] },
  });
  expect(() =>
    parseDiscussionDecision(
      wire({ action: 'delegate', work }, 'Proposal'),
      'coordinator',
      2,
    ),
  ).toThrow('GROUP_DISCUSSION_INVALID_DECISION');
  for (const forged of [
    { ...work, tool_capabilities: ['read_device_file'] },
    { ...work, tool_capabilities: ['shell'] },
    { ...work, max_model_attempts: 13 },
    { ...work, grant_id: 'forged-grant' },
  ])
    expect(() =>
      parseDiscussionDecision(
        wire({ action: 'delegate', work: forged }, 'Proposal'),
        'speaker',
        2,
      ),
    ).toThrow('GROUP_DISCUSSION_INVALID_DECISION');
});

test('natural v2 guidance permits useful disagreement and quiet PASS without mandatory quotation', () => {
  const prompt = discussionOutputContract('speaker', 2, true);
  expect(prompt).toContain('public_message');
  expect(prompt).toContain('control');
  expect(prompt).toContain('do not force quotations');
  expect(prompt).toContain('PASS quietly');
  expect(discussionOutputContract('speaker', 1, false)).toContain(
    'Peer relay is disabled',
  );
});

test('coordinator guidance preserves explicitly requested participation before finishing', () => {
  for (const version of [1, 2] as const) {
    const prompt = discussionOutputContract('coordinator', version, false);
    expect(prompt).toContain(
      'explicit requested participants, order and number of contributions',
    );
    expect(prompt).toContain(
      'wait_for_user if a required contribution cannot be obtained',
    );
  }
});

test('empty model output has a distinct actionable failure', () => {
  expect(() => parseDiscussionDecision('  ', 'coordinator', 2)).toThrow(
    'GROUP_DISCUSSION_EMPTY_MODEL_OUTPUT',
  );
});
