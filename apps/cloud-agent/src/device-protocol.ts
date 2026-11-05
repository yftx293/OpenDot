// Standalone Worker validators: never resolve the Node workspace's zod.
// Conformance tests compare these schemas with the Node protocol.
import { z } from 'zod';
export {
  CLOUD_DEVICE_INTENT_MEMO,
  CLOUD_DEVICE_RECEIPT_MEMO,
  CLOUD_DEVICE_GRANT_MEMO,
  CLOUD_DEVICE_RESULT_MEMO,
} from '../../../src/personal-agent/cloud-device-memos.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CloudDeviceIntentSchema = z
  .object({
    id: z.string().regex(/^task:[1-9][0-9]*$/),
    conversation_id: z.literal(1),
    task_id: z.number().int().positive(),
    generation_task_id: z.number().int().positive(),
    call_id: z.string().min(1).max(200),
    name: z.literal('read_device_file'),
    parameters: z
      .object({ node_id: z.uuid(), path: z.string().min(1).max(2048) })
      .strict(),
    parameters_digest: hash,
  })
  .strict();
export type CloudDeviceIntent = z.infer<typeof CloudDeviceIntentSchema>;
export const CloudDeviceIdentitySchema = z
  .object({
    request_id: z.uuid(),
    owner_user_id: z.string().min(1).max(200),
    workspace_jid: z.string().startsWith('web:').max(256),
    goal_id: z.uuid(),
    run_id: z.uuid(),
    handoff_id: z.uuid(),
    cloud_session_id: z.uuid(),
    node_id: z.uuid(),
    path: z.string().min(1).max(2048),
    operation_digest: hash,
    deadline_at: z.number().int().positive(),
  })
  .strict();
export type CloudDeviceIdentity = z.infer<typeof CloudDeviceIdentitySchema>;
export const CloudDeviceGrantReceiptSchema = z
  .object({
    grant_id: z.uuid(),
    command_digest: hash,
    manifest_hash: hash,
    expires_at: z.string().min(1).max(100),
  })
  .strict();
export type CloudDeviceGrantReceipt = z.infer<
  typeof CloudDeviceGrantReceiptSchema
>;
export const CloudDeviceResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      content: z
        .string()
        .refine((v) => new TextEncoder().encode(v).byteLength <= 65536),
      content_digest: hash,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error_code: z.enum([
        'FILE_UNAVAILABLE',
        'FILE_FORBIDDEN',
        'INVALID_UTF8',
        'FILE_TOO_LARGE',
      ]),
    })
    .strict(),
]);
export const CloudDeviceResponseSchema = z.union([
  z.object({ state: z.literal('missing') }).strict(),
  z
    .object({
      identity: CloudDeviceIdentitySchema,
      state: z.enum([
        'waiting_for_permission',
        'waiting_for_device',
        'dispatched',
        'completed',
        'failed',
        'cancelled',
      ]),
      grant: CloudDeviceGrantReceiptSchema.optional(),
      result: CloudDeviceResultSchema.optional(),
    })
    .strict(),
]);
export type CloudDeviceResponse = z.infer<typeof CloudDeviceResponseSchema>;
export const CloudDeviceRequestSchema = CloudDeviceIntentSchema.extend({
  phase: z.enum(['probe', 'propose', 'status', 'consume', 'confirm']),
  receipt: CloudDeviceIdentitySchema.optional(),
  result_digest: hash.optional(),
}).strict();
export const CloudDeviceProofSchema = z
  .object({
    intent: CloudDeviceIntentSchema,
    receipt: CloudDeviceIdentitySchema,
    grant: CloudDeviceGrantReceiptSchema.optional(),
  })
  .strict();
export type CloudDeviceProof = z.infer<typeof CloudDeviceProofSchema>;
