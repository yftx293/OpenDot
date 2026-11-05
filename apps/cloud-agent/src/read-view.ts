import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  UsageDoc,
  ROOT_CONVERSATION_ID,
  type Cursor,
  type ConversationView,
  type EntryRecord,
  type JsonObject,
} from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { CloudError } from './protocol';

/** Storage reads only. Even a paused Harness.open reconciles running tasks,
 * so opening a second Harness is never a read-only operation. */
export async function readRootView(
  storage: SqliteStorage,
): Promise<ConversationView> {
  const conversation = await storage.conversation(ROOT_CONVERSATION_ID, BG);
  if (!conversation || conversation.parent || conversation.owner)
    throw new CloudError(409, 'CLOUD_ROOT_BINDING_CONFLICT');
  const tail = (
    await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID, order: 'descending' },
      1,
      undefined,
      BG,
    )
  ).items[0]?.id;
  const head =
    tail &&
    (await storage.findLatestHeadMarker(ROOT_CONVERSATION_ID, tail, BG));
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  if (tail)
    do {
      const page = await storage.scanEntries(
        {
          conversationId: ROOT_CONVERSATION_ID,
          order: 'ascending',
          maxEntryId: tail,
          ...(head ? { minEntryId: head.head } : {}),
        },
        100,
        cursor,
        BG,
      );
      entries.push(...page.items);
      if (entries.length > 10000)
        throw new CloudError(429, 'CLOUD_SNAPSHOT_BUDGET_EXHAUSTED');
      cursor = page.next;
    } while (cursor !== undefined);
  const docs: Record<string, JsonObject> = {};
  for (const token of [AgentDoc, InboxDoc, LiveDoc, ProviderDoc, UsageDoc]) {
    const record = await storage.findDocument(
      {
        kind: token.definition.kind,
        scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
      },
      'current',
      BG,
    );
    const document =
      record && (await storage.document(record.id, 'current', BG));
    if (!document) continue;
    if (document.version !== token.definition.version)
      throw new CloudError(409, 'CLOUD_DOCUMENT_MIGRATION_REQUIRED');
    docs[token.definition.kind] = document.value;
  }
  // Public ConversationView contract: newest head marker, then non-head entries
  // in its selected range. This is presentation, never reconstructed model input.
  return {
    conversation,
    entries: [
      ...(head ? [head] : []),
      ...entries.filter((entry) => entry.head === undefined),
    ],
    docs,
  };
}
