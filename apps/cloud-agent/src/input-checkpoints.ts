import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  defineDocFamily,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type Cursor,
  type Harness,
} from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { CloudError, digest, InputSchema, type CloudInput } from './protocol';
const Receipts = defineDocFamily<{ digest: string; verified: boolean }, string>(
  {
    family: true,
    kind: 'miniclaw.cloud-input',
    version: 1,
    scope: 'session',
    initial: (hash) => ({ digest: hash, verified: false }),
  },
);
export async function bindInput(conversation: Conversation, input: CloudInput) {
  const hash = await digest(JSON.stringify(input));
  const key = await digest(input.request_id);
  await conversation.commit(async (tx) => {
    const existing = await tx.submissionByRequest(
      conversation.id,
      input.request_id,
    );
    const receipt = await tx.doc(Receipts, `${conversation.id}:${key}`, hash);
    if (receipt.digest !== hash || (existing && !receipt.verified))
      throw new CloudError(409, 'CLOUD_CHECKPOINT_BINDING_CONFLICT');
    receipt.verified = true;
  }, BG);
}
export async function validateInputCheckpoints(
  harness: Harness | null,
  storage: SqliteStorage,
  rows: {
    id: string;
    digest: string;
    payload: string;
    submission_id: number | null;
  }[],
  authorizeInput: (
    input: CloudInput,
    native: {
      submission_id: number | null;
      status: 'missing' | 'queued' | 'placed' | 'done' | 'unanswered';
    },
  ) => Promise<void>,
  onBound: (requestId: string, submissionId: number) => void,
  readOnly = false,
) {
  const conversation = readOnly ? null : await harness!.root(BG);
  if (!(await storage.conversation(ROOT_CONVERSATION_ID, BG)))
    throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
  // This pilot exposes exactly one Root. Pi scheduling is Harness-wide, so
  // checking only that Root's submissions must not activate another scope.
  let scopeCursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, 100, scopeCursor, BG);
    if (
      page.items.some(
        (row) => row.id !== ROOT_CONVERSATION_ID || row.parent || row.owner,
      )
    )
      throw new CloudError(409, 'CLOUD_CONVERSATION_SCOPE_CONFLICT');
    scopeCursor = page.next;
  } while (scopeCursor !== undefined);
  do {
    const page = await storage.scanTasks({}, 100, scopeCursor, BG);
    if (page.items.some((row) => row.conversationId !== ROOT_CONVERSATION_ID))
      throw new CloudError(409, 'CLOUD_TASK_SCOPE_CONFLICT');
    scopeCursor = page.next;
  } while (scopeCursor !== undefined);
  const expected = new Map(rows.map((row) => [row.id, row]));
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions(
      { conversationId: ROOT_CONVERSATION_ID },
      100,
      cursor,
      BG,
    );
    for (const submission of page.items) {
      const row = submission.requestId
        ? expected.get(submission.requestId)
        : undefined;
      if (
        submission.type !== 'input' ||
        !row ||
        (row.submission_id !== null &&
          row.submission_id !== Number(submission.id))
      )
        throw new CloudError(409, 'CLOUD_UNTRUSTED_CHECKPOINT');
    }
    cursor = page.next;
  } while (cursor !== undefined);
  // The PiHarness factory must stay paused. Verify every product/native binding,
  // then every native digest Doc. Admission gaps are handed to their already
  // persisted Lifecycle job after startup, never submitted from this factory.
  const verified: { input: CloudInput; nativeId: number | null }[] = [];
  for (const row of rows) {
    const input = InputSchema.parse(JSON.parse(row.payload));
    if (
      input.request_id !== row.id ||
      (await digest(JSON.stringify(input))) !== row.digest
    )
      throw new CloudError(409, 'CLOUD_INTENT_CORRUPT');
    const native = await storage.submissionByRequest(
      ROOT_CONVERSATION_ID,
      row.id,
      BG,
    );
    if (
      row.submission_id !== null &&
      (!native || Number(native.id) !== row.submission_id)
    )
      throw new CloudError(409, 'CLOUD_UNTRUSTED_CHECKPOINT');
    await authorizeInput(input, {
      submission_id: native ? Number(native.id) : null,
      status: native?.status ?? 'missing',
    });
    verified.push({ input, nativeId: native ? Number(native.id) : null });
  }
  if (readOnly) return;
  for (const { input } of verified) await bindInput(conversation!, input);
  for (const { input, nativeId } of verified)
    if (nativeId !== null) onBound(input.request_id, nativeId);
}
