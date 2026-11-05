import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  ROOT_CONVERSATION_ID,
  LiveDoc,
  ToolTask,
  GenerationTask,
  type TaskId,
  type SubmissionId,
  type ConversationId,
} from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import {
  nativeProductSource,
  type NativeSourceLive,
} from '../../../src/personal-agent/native-product-source.js';
import { CloudError } from './protocol';

/** Called inside the existing Cloud owner; never opens a second Pi Harness.
 * Task/conversation IDs come from native HookApi/ToolExecutionApi, not the model. */
export async function cloudMemberSource(
  storage: SqliteStorage,
  identity: { conversationId: ConversationId; taskId: number },
  kind: 'tool' | 'generation',
  authority: { active(): boolean; authorize(): void | Promise<void> },
) {
  if (identity.conversationId !== ROOT_CONVERSATION_ID)
    throw new CloudError(409, 'CLOUD_MEMBER_SOURCE_SCOPE_CONFLICT');
  return nativeProductSource({
    ...identity,
    kind,
    ...authority,
    generationKind: GenerationTask.definition.name,
    toolKind: ToolTask.definition.name,
    liveVersion: LiveDoc.definition.version,
    task: (id) => storage.task(id as TaskId, BG),
    submission: (id) => storage.submission(id as SubmissionId, BG),
    readLive: async () => {
      const record = await storage.findDocument(
        {
          kind: LiveDoc.definition.kind,
          scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
        },
        'current',
        BG,
      );
      const doc = record && (await storage.document(record.id, 'current', BG));
      return doc
        ? {
            version: doc.version,
            value: doc.value as unknown as NativeSourceLive,
          }
        : undefined;
    },
  });
}
