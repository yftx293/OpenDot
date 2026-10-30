import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  defineDocFamily,
  type Conversation,
  type ConversationId,
  type Storage,
} from '@earendil-works/pi-durable';

// Session scope avoids copying request bindings into a forked conversation.
const InputRequest = defineDocFamily<
  { payloadDigest: string; verified: boolean },
  string
>({
  kind: 'miniclaw.input-request',
  version: 1,
  family: true,
  scope: 'session',
  initial: (payloadDigest) => ({ payloadDigest, verified: false }),
});

export class DurableInputConflict extends Error {
  readonly code = 'DURABLE_INPUT_CONFLICT';
}

export function validateDurableInput(requestId: string, content: string): void {
  if (
    typeof requestId !== 'string' ||
    !requestId.trim() ||
    Buffer.byteLength(requestId, 'utf8') > 256
  ) {
    throw new Error('Durable input request ID must contain 1–256 UTF-8 bytes');
  }
  if (typeof content !== 'string') {
    throw new Error('Durable input content must be a string');
  }
}

const requestKey = (requestId: string) =>
  createHash('sha256').update(requestId, 'utf8').digest('hex');
const payloadDigest = (content: string) =>
  createHash('sha256')
    .update('miniclaw.input.v1\0', 'utf8')
    .update(content, 'utf8')
    .digest('hex');

/** Verify an existing admission binding using committed reads only. */
export async function verifyDurableInputPayload(
  storage: Storage,
  conversationId: ConversationId,
  requestId: string,
  content: string,
): Promise<void> {
  validateDurableInput(requestId, content);
  const record = await storage.findDocument(
    {
      kind: InputRequest.definition.kind,
      scope: { kind: 'session' },
      key: `${conversationId}:${requestKey(requestId)}`,
    },
    'current',
    BACKGROUND_CONTEXT,
  );
  const stored =
    record &&
    (await storage.document(record.id, 'current', BACKGROUND_CONTEXT));
  const data = stored?.value as
    | { payloadDigest?: string; verified?: boolean }
    | undefined;
  if (
    !stored ||
    stored.version !== InputRequest.definition.version ||
    data?.verified !== true ||
    data.payloadDigest !== payloadDigest(content)
  )
    throw new DurableInputConflict(
      'Native MCP source lacks an exact product input binding',
    );
}

/** Persist the payload binding before admission; a crash between commits is retry-safe. */
export async function bindDurableInputPayload(
  conversation: Conversation,
  requestId: string,
  content: string,
): Promise<void> {
  validateDurableInput(requestId, content);
  const key = requestKey(requestId);
  const digest = payloadDigest(content);
  await conversation.commit(async (tx) => {
    const existing = await tx.submissionByRequest(conversation.id, requestId);
    const receipt = await tx.doc(
      InputRequest,
      `${conversation.id}:${key}`,
      digest,
    );
    // Never retroactively trust a new payload for an unverified old submission.
    if (existing && !receipt.verified) {
      throw new DurableInputConflict(
        'Existing Durable request has no verified payload binding',
      );
    }
    if (receipt.payloadDigest !== digest) {
      throw new DurableInputConflict(
        'Durable request ID payload digest mismatch',
      );
    }
    receipt.verified = true;
  }, BACKGROUND_CONTEXT);
}
