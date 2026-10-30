import { createHash } from 'node:crypto';
import { BotGroupError } from './protocol.js';

export const DISCUSSION_INPUT_BYTES = 32768;

/** Prefix bounded by its serialized UTF-8 cost, including JSON escaping. */
export function boundedDiscussionText(value: string, budget: number) {
  let low = 0,
    high = Math.min(value.length, Math.max(0, budget));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(JSON.stringify(value.slice(0, mid)), 'utf8') <= budget
    )
      low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
}

export type DiscussionContextMessage = {
  id: string;
  seq: number;
  content: string;
  truncated: boolean;
  omitted_characters: number;
  since_last_read?: boolean;
  author_kind?: string;
  author?: string;
  profile_id?: string | null;
  mentions?: unknown;
};
type Range = { from_seq: number; through_seq: number };
type BudgetedContext = {
  root_question: {
    content: string;
    truncated: boolean;
    omitted_characters: number;
  };
  earlier_root: {
    root: string;
    truncated: boolean;
    omitted_characters: number;
  } | null;
  recent_and_delta: DiscussionContextMessage[];
  user_interjections: DiscussionContextMessage[];
  unread_ids: string[];
  user_interjection_ids: string[];
  omitted_unread_ranges: Range[];
  canonical_through_seq: number;
  last_read_seq: number;
  history_truncated: boolean;
  context_digest: string;
};

/** Pure final selection: budget the exact envelope, not just message text.
 * Drop already-read background first, then shorten the delivered delta. Fresh
 * user constraints and the native work result take priority. If a whole unread
 * message must be omitted, keep the contiguous cursor before it. Never rebuild
 * this input on retry: the caller persists the returned bytes and boundary. */
export function freezeDiscussionContext<T extends BudgetedContext>(
  selection: { context: T; through: number },
  speakerContract: Record<string, unknown>,
  limit = DISCUSSION_INPUT_BYTES,
) {
  const context = {
    ...structuredClone(selection.context),
    context_digest: '0'.repeat(64),
    read_through_seq: selection.through,
    omitted_history_ranges: [] as Range[],
  };
  const contract = structuredClone(speakerContract);
  const render = () =>
    JSON.stringify({ ...context, speaker_contract: contract });
  const bytes = () => Buffer.byteLength(render(), 'utf8');
  const over = () => Math.max(0, bytes() - limit);
  const protectedIds = new Set(context.user_interjection_ids);
  const shorten = (
    fragment: object,
    key: string,
    budget: number,
    flag = 'truncated',
    omitted = 'omitted_characters',
  ) => {
    const fields = fragment as Record<string, unknown>;
    const value = fields[key];
    if (typeof value !== 'string') return;
    const text = boundedDiscussionText(value, budget);
    if (text === value) return;
    fields[key] = text;
    fields[flag] = true;
    fields[omitted] =
      (typeof fields[omitted] === 'number' ? fields[omitted] : 0) +
      value.length -
      text.length;
    context.history_truncated = true;
  };
  const fitText = (
    fragment: object,
    key: string,
    floor: number,
    flag = 'truncated',
    omitted = 'omitted_characters',
  ) => {
    const value = (fragment as Record<string, unknown>)[key];
    if (!over() || typeof value !== 'string') return;
    const cost = Buffer.byteLength(JSON.stringify(value), 'utf8');
    // Leave room for explicit truncation metadata, including escaped text.
    shorten(fragment, key, Math.max(floor, cost - over() - 128), flag, omitted);
  };

  // Work instructions are bounded by bytes, not the protocol's character cap.
  // Preserve the real result ID/digest and record every omitted character.
  const returned = contract.work_return;
  if (returned && typeof returned === 'object') {
    shorten(
      returned,
      'instruction',
      4000,
      'instruction_truncated',
      'instruction_omitted_characters',
    );
    shorten(returned, 'public_result', 4000);
  }

  const history = context.recent_and_delta.filter((m) => !m.since_last_read);
  for (const message of history) {
    if (!over()) break;
    context.recent_and_delta = context.recent_and_delta.filter(
      (m) => m.id !== message.id,
    );
    const previous = context.omitted_history_ranges.at(-1);
    if (previous && previous.through_seq + 1 === message.seq)
      previous.through_seq = message.seq;
    else
      context.omitted_history_ranges.push({
        from_seq: message.seq,
        through_seq: message.seq,
      });
    context.history_truncated = true;
  }
  if (context.earlier_root) fitText(context.earlier_root, 'root', 128);

  const delta = context.recent_and_delta
    .filter((m) => m.since_last_read && !protectedIds.has(m.id))
    .sort((a, b) => b.content.length - a.content.length || a.seq - b.seq);
  for (const message of delta) fitText(message, 'content', 256);

  // These are the last content reductions, after background and older delta.
  // A prefix is never presented as the full original message or task.
  if (returned && typeof returned === 'object')
    fitText(
      returned,
      'instruction',
      512,
      'instruction_truncated',
      'instruction_omitted_characters',
    );
  fitText(context.root_question, 'content', 1024);
  const userMessages = [
    ...context.recent_and_delta,
    ...context.user_interjections,
  ]
    .filter((m) => protectedIds.has(m.id))
    .sort((a, b) => a.seq - b.seq);
  for (const message of userMessages) fitText(message, 'content', 512);

  // Unusual metadata-heavy messages may still exceed the envelope budget.
  // Remove the latest unprotected unread entries without skipping their gap.
  for (const message of [...delta].sort((a, b) => b.seq - a.seq)) {
    if (!over()) break;
    context.recent_and_delta = context.recent_and_delta.filter(
      (m) => m.id !== message.id,
    );
    context.unread_ids = context.unread_ids.filter((id) => id !== message.id);
    context.read_through_seq = Math.min(
      context.read_through_seq,
      message.seq - 1,
    );
    const firstOmitted = Math.min(
      message.seq,
      ...context.omitted_unread_ranges.map((range) => range.from_seq),
    );
    context.omitted_unread_ranges = [
      { from_seq: firstOmitted, through_seq: context.canonical_through_seq },
    ];
    context.history_truncated = true;
  }
  if (over()) throw new BotGroupError('GROUP_DISCUSSION_CONTEXT_TOO_LARGE');

  const { context_digest: previousDigest, ...digestSource } = context;
  context.context_digest = createHash('sha256')
    .update(JSON.stringify(digestSource))
    .digest('hex');
  return { content: render(), through: context.read_through_seq };
}
