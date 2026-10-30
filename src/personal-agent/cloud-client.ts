import { memberCloudExecution } from '../bot-groups/member-inbox-store.js';
import { z } from 'zod';
import type { ConversationView } from '@earendil-works/pi-durable';
import {
  signedRequest,
  CLOUD_MAX_BODY_BYTES,
  boundedBody,
  CloudError,
  digest,
  type CloudBinding,
  type CloudExecutionGrant,
} from './cloud-wire.js';
import {
  getCloudPlacement,
  bindCloudObject,
  bindProductConversation,
  markProductInputSubmitted,
  type ProductInput,
  type ProductInputPayload,
  type QueueControl,
} from './product-runtime-store.js';
import type { CloudStopFence } from './cloud-lifecycle.js';
import type { CloudDeviceProof } from './cloud-device-wire.js';

const Identity = z.object({
  runtime: z.literal('cloudflare-durable'),
  session_id: z.uuid(),
  object_id: z.string().regex(/^[a-f0-9]{64}$/),
  conversation_id: z.literal(1),
  epoch: z.uuid(),
});
const Snapshot = Identity.extend({
  revision: z.number().int().positive(),
  steps: z.number().int().nonnegative(),
  state: z.string(),
  device_waits: z
    .array(
      z.object({
        task_id: z.number().int().positive(),
        request_id: z.uuid(),
        kind: z.enum(['permission', 'device']),
        state: z.string(),
        attempts: z.number().int().min(0).max(8),
        activation_attempts: z.number().int().min(0).max(8),
      }),
    )
    .max(20)
    .default([]),
  billing_status: z.literal('unpriced'),
  view: z.object({
    conversation: z.object({ id: z.literal(1) }).passthrough(),
    entries: z.array(z.unknown()),
    docs: z.record(z.string(), z.unknown()),
  }),
  inputs: z.array(
    z.object({
      id: z.string(),
      digest: z.string(),
      submission_id: z.number().int().positive().nullable(),
      status: z.string(),
      answer_entry_id: z.number().int().positive().optional(),
    }),
  ),
  deliveries: z
    .array(
      z.object({
        id: z.string(),
        state: z.enum(['pending', 'delivered', 'blocked']),
        attempts: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  waits: z
    .array(
      z.object({
        task_id: z.number().int().positive(),
        approval_id: z.uuid(),
        kind: z.enum(['approval', 'receipt']),
        state: z.string(),
        attempts: z.number().int().nonnegative(),
      }),
    )
    .max(20)
    .default([]),
  execution: z
    .object({
      goal_id: z.uuid(),
      run_id: z.uuid(),
      context_digest: z.string().regex(/^[a-f0-9]{64}$/),
      deadline_at: z.number().int().positive(),
      max_model_steps: z.literal(12),
      steps: z.number().int().min(0).max(12),
    })
    .strict()
    .optional(),
  recovery: z
    .array(
      z.union([
        z
          .object({
            kind: z.literal('member'),
            run_id: z.uuid(),
            lease_id: z.uuid(),
            attempts: z.number().int().min(0).max(8),
            state: z.enum(['waiting', 'resumed', 'exhausted', 'suspended']),
            not_before: z.number().int().nonnegative(),
          })
          .strict(),
        z
          .object({
            run_id: z.uuid(),
            attempts: z.number().int().min(0).max(8),
            state: z.enum(['waiting', 'resumed', 'exhausted', 'suspended']),
            not_before: z.number().int().nonnegative(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('handoff'),
            runtime_id: z.uuid(),
            handoff_id: z.uuid(),
            attempts: z.number().int().min(0).max(8),
            state: z.enum(['waiting', 'resumed', 'exhausted', 'suspended']),
            not_before: z.number().int().nonnegative(),
          })
          .strict(),
      ]),
    )
    .max(100)
    .default([]),
});

function cloudInputBody(
  sessionId: string,
  requestId: string,
  payload: ProductInputPayload,
  payloadDigest: string,
) {
  const member = memberCloudExecution(sessionId, requestId);
  return {
    request_id: requestId,
    content: payload.content,
    when_busy: payload.followUpBehavior === 'steer' ? 'steer' : 'followUp',
    product_receipt_digest: payloadDigest,
    ...(member ? { member } : {}),
    ...(payload.execution
      ? {
          execution: {
            goal_id: payload.execution.goalId,
            run_id: payload.execution.runId,
            context_digest: payload.execution.contextDigest,
          },
        }
      : {}),
  };
}

export function assertCloudInputFits(
  sessionId: string,
  requestId: string,
  payload: ProductInputPayload,
) {
  // A committed product receipt digest is always 64 ASCII hex characters.
  const body = JSON.stringify(
    cloudInputBody(sessionId, requestId, payload, '0'.repeat(64)),
  );
  if (Buffer.byteLength(body, 'utf8') > CLOUD_MAX_BODY_BYTES)
    throw new CloudError(413, 'CLOUD_REQUEST_TOO_LARGE');
}

/** Private transport only. Existing authenticated product routes remain the browser API. */
export class CloudSessionClient {
  constructor(
    private readonly authorize: (id: string) => void,
    private readonly authorizeStop: (id: string) => void = authorize,
  ) {}
  private async call(
    id: string,
    suffix: string,
    method = 'GET',
    value?: unknown,
  ) {
    const authorize =
      suffix === '/suspend' ? this.authorizeStop : this.authorize;
    authorize(id);
    const placement = getCloudPlacement(id);
    if (!placement) throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
    const binding = JSON.parse(placement.binding_json) as CloudBinding;
    const url = `${placement.gateway_origin}/internal/cloud-sessions${suffix === 'create' ? '' : `/${id}${suffix}`}`;
    const body = value === undefined ? '' : JSON.stringify(value);
    // Match the Worker's byte limit before signing or dispatching; measuring
    // characters misses UTF-8 and JSON escape expansion.
    if (Buffer.byteLength(body, 'utf8') > CLOUD_MAX_BODY_BYTES)
      throw new CloudError(413, 'CLOUD_REQUEST_TOO_LARGE');
    const signed = await signedRequest(
      process.env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
      binding,
      url,
      method,
      body,
    );
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 20000);
    try {
      const response = await fetch(
        new Request(signed, { signal: control.signal }),
        { redirect: 'error' },
      );
      // Bound the JSON response as well as headers; never return raw gateway errors.
      if (!response.ok) {
        if (response.status === 409) {
          let pending = false;
          try {
            pending =
              (JSON.parse(await boundedBody(response)) as { error?: unknown })
                .error === 'CLOUD_PREVIOUS_EXECUTION_PENDING';
          } catch {
            /* Never expose raw gateway/provider errors. */
          }
          if (pending)
            throw new CloudError(409, 'CLOUD_PREVIOUS_EXECUTION_PENDING');
        }
        await response.body?.cancel();
        throw new CloudError(
          response.status === 409 ? 409 : 503,
          'CLOUD_OPERATION_UNAVAILABLE',
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CloudError(503, 'CLOUD_INVALID_RESPONSE');
      let bytes = 0,
        raw = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          bytes += chunk.byteLength;
          if (bytes > 4 * 1024 * 1024)
            throw new CloudError(503, 'CLOUD_RESPONSE_TOO_LARGE');
          raw += decoder.decode(chunk, { stream: true });
        }
        raw += decoder.decode();
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      authorize(id);
      return JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof CloudError) throw error;
      throw new CloudError(503, 'CLOUD_OPERATION_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }
  async provision(id: string, execution?: CloudExecutionGrant) {
    const placement = getCloudPlacement(id)!;
    const binding = JSON.parse(placement.binding_json) as CloudBinding;
    if (!!binding.goal_id !== !!execution)
      throw new CloudError(409, 'CLOUD_WAITING_FOR_SCHEDULER');
    const result = Identity.parse(
      await this.call(
        id,
        'create',
        'POST',
        execution ? { binding, execution } : binding,
      ),
    );
    if (result.session_id !== id)
      throw new CloudError(409, 'CLOUD_IDENTITY_CONFLICT');
    bindCloudObject(id, placement.runtime_id, result.object_id);
    bindProductConversation(id, result.conversation_id);
  }
  async execution(id: string, grant: CloudExecutionGrant) {
    z.object({
      accepted: z.literal(true),
      session_id: z.literal(id),
      run_id: z.literal(grant.run_id),
    })
      .strict()
      .parse(await this.call(id, '/executions', 'POST', grant));
  }
  async suspend(id: string, fence: CloudStopFence) {
    return z
      .object({
        accepted: z.literal(true),
        session_id: z.literal(id),
        fence_digest: z.literal(await digest(JSON.stringify(fence))),
        state: z.enum(['suspended', 'cancelled']),
      })
      .strict()
      .parse(await this.call(id, '/suspend', 'POST', { fence }));
  }
  async resumeHandoff(
    id: string,
    fence: Extract<CloudStopFence, { kind: 'handoff' }>,
  ) {
    return z
      .object({
        accepted: z.literal(true),
        session_id: z.literal(id),
        fence_digest: z.literal(await digest(JSON.stringify(fence))),
        state: z.enum([
          'active',
          'waiting_for_approval',
          'waiting_for_receipt',
          'waiting_for_device',
          'waiting_for_device_permission',
        ]),
      })
      .strict()
      .parse(await this.call(id, '/resume', 'POST', { fence }));
  }
  async submit(input: ProductInput) {
    const payload = JSON.parse(input.payload) as ProductInputPayload;
    const result = z
      .object({
        receipt: z.object({
          operationId: z.string(),
          request_id: z.string(),
          submission_id: z.number().int().positive(),
        }),
      })
      .parse(
        await this.call(
          input.session_id,
          '/messages',
          'POST',
          cloudInputBody(
            input.session_id,
            input.request_id,
            payload,
            input.payload_digest,
          ),
        ),
      );
    if (
      result.receipt.operationId !== input.request_id ||
      result.receipt.request_id !== input.request_id
    )
      throw new CloudError(409, 'CLOUD_SUBMISSION_CONFLICT');
    markProductInputSubmitted(input.id, result.receipt.submission_id);
    return result.receipt.submission_id;
  }
  async snapshot(id: string) {
    const result = Snapshot.parse(await this.call(id, ''));
    if (
      result.session_id !== id ||
      result.object_id !== getCloudPlacement(id)?.object_id
    )
      throw new CloudError(409, 'CLOUD_IDENTITY_CONFLICT');
    return { ...result, view: result.view as unknown as ConversationView };
  }
  async abort(id: string, requestId: string) {
    await this.call(id, '/abort', 'POST', { request_id: requestId });
  }
  async resumeApproval(id: string, approvalId: string) {
    z.object({ approval_id: z.literal(approvalId), accepted: z.literal(true) })
      .strict()
      .parse(
        await this.call(id, '/approval-decisions', 'POST', {
          request_id: approvalId,
        }),
      );
  }
  async verifyDevice(id: string, proof: CloudDeviceProof) {
    return z
      .object({ verified: z.boolean() })
      .strict()
      .parse(await this.call(id, '/device-proof', 'POST', proof)).verified;
  }
  async wakeDevice(id: string, proof: CloudDeviceProof) {
    return z
      .object({ accepted: z.boolean() })
      .strict()
      .parse(await this.call(id, '/device-wakes', 'POST', proof)).accepted;
  }
  async control(row: QueueControl) {
    const result = z
      .object({
        id: z.uuid(),
        digest: z.string(),
        state: z.enum(['applied', 'rejected']),
      })
      .parse(
        await this.call(row.session_id, '/controls', 'POST', {
          id: row.id,
          digest: row.payload_digest,
          payload: row.payload,
        }),
      );
    if (result.id !== row.id || result.digest !== row.payload_digest)
      throw new CloudError(409, 'CLOUD_CONTROL_CONFLICT');
    return result.state === 'applied';
  }
}
