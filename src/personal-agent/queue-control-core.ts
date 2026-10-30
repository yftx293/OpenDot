// Portable queue protocol and mutation policy. No package, Node, SDK or storage
// imports: each execution host supplies its own SDK documents/transaction.
export type QueueCommand =
  | {
      expectedQueueDigest: string;
      submissionId: number;
      action: 'edit';
      content: string;
    }
  | {
      expectedQueueDigest: string;
      submissionId: number;
      action: 'cancel' | 'steer';
    }
  | { expectedQueueDigest: string; action: 'abort'; taskId: number }
  | { expectedQueueDigest: string; action: 'reorder'; submissionIds: number[] };
export type PreparedQueueCommand = {
  command: QueueCommand;
  targets: { submissionId: number; requestId: string }[];
  payload?: string;
  goalRunId?: string;
};
export const QUEUE_RECEIPT_KIND = 'miniclaw.queue-control';
export const initialQueueReceipt = (digest: string) => ({
  digest,
  settled: false,
  applied: false,
});

/** Canonical wire parser for hosts without a root package installation. Matches
 * the existing product Zod schema, including output key order and trimming. */
export function parseQueueCommand(raw: unknown): QueueCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid queue command');
  const input = raw as Record<string, unknown>;
  const positive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  const digest = input.expectedQueueDigest;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error('Invalid queue digest');
  const exact = (keys: string[]) => {
    if (Object.keys(input).sort().join(',') !== keys.sort().join(','))
      throw new Error('Invalid queue fields');
  };
  if (input.action === 'abort') {
    exact(['expectedQueueDigest', 'action', 'taskId']);
    if (!positive(input.taskId)) throw new Error('Invalid task ID');
    return {
      expectedQueueDigest: digest,
      action: 'abort',
      taskId: input.taskId,
    };
  }
  if (input.action === 'reorder') {
    exact(['expectedQueueDigest', 'action', 'submissionIds']);
    if (
      !Array.isArray(input.submissionIds) ||
      input.submissionIds.length > 500 ||
      !Array.from(input.submissionIds).every(positive)
    )
      throw new Error('Invalid submission IDs');
    return {
      expectedQueueDigest: digest,
      action: 'reorder',
      submissionIds: [...input.submissionIds],
    };
  }
  if (
    input.action !== 'edit' &&
    input.action !== 'cancel' &&
    input.action !== 'steer'
  )
    throw new Error('Invalid action');
  exact([
    'expectedQueueDigest',
    'submissionId',
    'action',
    ...(input.action === 'edit' ? ['content'] : []),
  ]);
  if (!positive(input.submissionId)) throw new Error('Invalid submission ID');
  if (input.action === 'edit') {
    if (
      typeof input.content !== 'string' ||
      !input.content.trim() ||
      input.content.trim().length > 16000
    )
      throw new Error('Invalid edited content');
    return {
      expectedQueueDigest: digest,
      submissionId: input.submissionId,
      action: 'edit',
      content: input.content.trim(),
    };
  }
  return {
    expectedQueueDigest: digest,
    submissionId: input.submissionId,
    action: input.action,
  };
}
export interface QueueReceipt {
  digest: string;
  settled: boolean;
  applied: boolean;
}
// Only existing native items are reordered/edited. The core never creates an ID
// or a new Inbox item; the SDK adapter owns branded IDs and settlement writes.
export interface MutableQueueInbox {
  items: { id: number; mode: string; content?: unknown }[];
}
export interface QueueRecord {
  readonly id: number;
  readonly type: string;
  readonly status: string;
  readonly conversationId: number;
}
export async function applyQueueControlCore(
  data: {
    conversationId: number;
    receipt: QueueReceipt;
    inbox: MutableQueueInbox;
    records: readonly (QueueRecord | undefined)[];
    task: { readonly conversationId: number } | null | undefined;
    live: { readonly run?: { readonly taskId: number } } | null;
    settle: (id: number) => void;
    digestItems: (items: unknown) => string | Promise<string>;
  },
  digest: string,
  prepared: PreparedQueueCommand,
  authorize: (mutating: boolean) => boolean | void,
  mustExist: boolean,
) {
  const { receipt, inbox, records, task, live } = data;
  const command = prepared.command;
  const ids =
    command.action === 'abort'
      ? []
      : command.action === 'reorder'
        ? command.submissionIds
        : [command.submissionId];
  authorize(false);
  if (receipt.digest !== digest)
    throw new Error('Queue control binding conflict');
  if (receipt.settled) return { applied: receipt.applied };
  if (mustExist) throw new Error('Trusted control receipt is missing');
  const permitted = authorize(true);
  receipt.settled = true;
  if (permitted === false) return { applied: false };
  const users = inbox.items.filter((item) => item.mode !== 'write');
  if (
    (await data.digestItems(inbox.items)) !== command.expectedQueueDigest ||
    records.length !== ids.length ||
    records.some(
      (record, index) =>
        !record ||
        record.id !== ids[index] ||
        record.type !== 'input' ||
        record.status !== 'queued' ||
        record.conversationId !== data.conversationId,
    )
  )
    return { applied: false };
  if (command.action === 'abort') {
    if (
      !task ||
      task.conversationId !== data.conversationId ||
      live?.run?.taskId !== command.taskId
    )
      return { applied: false };
    receipt.applied = true;
    return { applied: true };
  }
  if (command.action === 'reorder') {
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== users.length ||
      users.some((item) => !ids.includes(item.id))
    )
      return { applied: false };
    const ordered = ids.map((id) => users.find((item) => item.id === id)!);
    let cursor = 0;
    for (let index = 0; index < inbox.items.length; index++)
      if (inbox.items[index].mode !== 'write')
        inbox.items[index] = ordered[cursor++];
  } else {
    const index = inbox.items.findIndex(
      (item) => item.id === command.submissionId && item.mode !== 'write',
    );
    if (index < 0) return { applied: false };
    const item = inbox.items[index];
    if (item.mode === 'write')
      throw new Error('Internal writes cannot be controlled');
    if (command.action === 'edit') {
      if (!prepared.payload) throw new Error('Edited payload binding missing');
      item.content = prepared.payload;
    } else if (command.action === 'steer') item.mode = 'steer';
    else {
      data.settle(item.id);
      inbox.items.splice(index, 1);
    }
  }
  receipt.applied = true;
  return { applied: true };
}
