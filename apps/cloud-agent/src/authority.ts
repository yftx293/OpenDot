import {
  CloudMemberToolRequestSchema,
  type CloudMemberModelProof,
} from './member-protocol';
import {
  bindingDigest,
  signedRequest,
  boundedBody,
  executionGrantDigest,
  digest,
  type CloudExecutionGrant,
  type CloudExecutionRef,
} from '../../../src/personal-agent/cloud-wire.js';
import {
  executionRef,
  StopFenceSchema,
  HandoffFenceSchema,
} from './execution-protocol';
import { z } from 'zod';
import { CloudError, type SessionBinding, type CloudInput } from './protocol';
export interface AuthorityEnvironment {
  MINICLAW_AUTHORITY_ORIGIN?: string;
  MINICLAW_CLOUD_ORIGIN?: string;
  MINICLAW_CLOUD_SHARED_SECRET?: string;
  MINICLAW_AUTHORITY_SERVICE?: Fetcher;
}
function origin(env: AuthorityEnvironment) {
  const url = new URL(
    env.MINICLAW_AUTHORITY_ORIGIN ?? 'https://unconfigured.invalid',
  );
  if (
    url.protocol !== 'https:' ||
    url.origin !== env.MINICLAW_AUTHORITY_ORIGIN ||
    url.username ||
    url.password
  )
    throw new CloudError(503, 'CLOUD_AUTHORITY_UNAVAILABLE');
  return url.origin;
}
async function request(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  suffix: string,
  body: string,
  signal?: AbortSignal,
  timeoutMs = 15000,
) {
  if (!/^[a-f0-9]{64}$/.test(objectId))
    throw new CloudError(503, 'CLOUD_AUTHORITY_UNAVAILABLE');
  const url = `${origin(env)}/api/cloud-runtime/${binding.session_id}/objects/${objectId}/${suffix}`;
  const signed = await signedRequest(
    env.MINICLAW_CLOUD_SHARED_SECRET ?? '',
    binding,
    url,
    'POST',
    body,
  );
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const outbound = new Request(signed, {
    signal: signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal,
  });
  let abort: () => void = () => {};
  try {
    if (outbound.signal.aborted)
      throw new CloudError(503, 'CLOUD_AUTHORITY_UNAVAILABLE');
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new CloudError(503, 'CLOUD_AUTHORITY_UNAVAILABLE'));
      outbound.signal.addEventListener('abort', abort, { once: true });
    });
    const pending = (
      env.MINICLAW_AUTHORITY_SERVICE
        ? env.MINICLAW_AUTHORITY_SERVICE.fetch(outbound)
        : fetch(outbound, { redirect: 'error' })
    ).then((response) => {
      if (outbound.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new CloudError(503, 'CLOUD_AUTHORITY_UNAVAILABLE');
      }
      return response;
    });
    return await Promise.race([pending, cancelled]);
  } finally {
    outbound.signal.removeEventListener('abort', abort);
    clearTimeout(timer);
  }
}
// The header deadline in request() is insufficient for a JSON response whose
// body stalls. Keep a total deadline and propagate the native invocation signal.
async function requestJson(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  suffix: string,
  body: string,
  signal?: AbortSignal,
): Promise<{ ok: false } | { ok: true; value: unknown }> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 15000);
  const combined = signal
    ? AbortSignal.any([signal, control.signal])
    : control.signal;
  try {
    const response = await request(
      env,
      binding,
      objectId,
      suffix,
      body,
      combined,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false };
    }
    return {
      ok: true,
      value: JSON.parse(await boundedBody(response, combined)),
    };
  } catch {
    throw new CloudError(503, 'CLOUD_AUTHORITY_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
export async function productTool(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  body: string,
  signal?: AbortSignal,
) {
  if (binding.execution_authority !== 'miniclaw-product')
    throw new CloudError(403, 'CLOUD_TOOL_NOT_GRANTED');
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 15000);
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  try {
    const response = await request(
      env,
      binding,
      objectId,
      'tools',
      body,
      combined,
    );
    if (!response.ok) {
      // Preserve known, explicit public admission denials for typed Group sends.
      // Other tools and arbitrary/transport errors retain their uncertain result.
      // The existing control fence also lets an old effect reach its next boundary.
      if (response.status === 409) {
        let rejected: string | undefined;
        try {
          const code = (
            JSON.parse(await boundedBody(response, combined)) as {
              error?: unknown;
            } | null
          )?.error;
          if (code === 'GROUP_MEMBER_CONTROL_NOT_CONSUMED') rejected = code;
          else if (
            typeof code === 'string' &&
            [
              'GROUP_MEMBER_HOP_LIMIT',
              'GROUP_MEMBER_INBOX_LIMIT',
              'GROUP_MEMBER_RECIPIENT_UNAVAILABLE',
              'GROUP_MEMBER_MESSAGE_LIMIT',
              'GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED',
              'GROUP_MEMBER_DELIVERY_EXPIRED',
            ].includes(code) &&
            binding.group_session
          ) {
            const input = CloudMemberToolRequestSchema.safeParse(
              JSON.parse(body),
            );
            if (input.success && input.data.name === 'ask_group_dot')
              rejected = code;
          }
        } catch {
          /* Unparseable responses carry no pre-effect proof. */
        }
        if (rejected) throw new CloudError(409, rejected);
      }
      await response.body?.cancel();
      throw new CloudError(503, 'CLOUD_TOOL_UNAVAILABLE');
    }
    return JSON.parse(await boundedBody(response, combined)) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
export async function authorizeProduct(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  purpose: 'execute' | 'read' = 'execute',
  execution?: CloudExecutionGrant,
  signal?: AbortSignal,
) {
  if (binding.execution_authority !== 'miniclaw-product') return;
  const response = await requestJson(
    env,
    binding,
    objectId,
    'policy',
    JSON.stringify({
      binding_digest: await bindingDigest(binding),
      gateway_origin: env.MINICLAW_CLOUD_ORIGIN,
      ...(purpose === 'read' ? { purpose } : {}),
      ...(execution
        ? {
            execution: executionRef(execution),
            execution_grant_digest: await executionGrantDigest(execution),
          }
        : {}),
    }),
    signal,
  );
  if (!response.ok) {
    throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
  }
  const result = (response.value ?? {}) as {
    authorized?: boolean;
    session_id?: string;
    runtime_id?: string;
    object_id?: string;
  };
  if (
    !result.authorized ||
    result.session_id !== binding.session_id ||
    result.runtime_id !== binding.runtime_id ||
    result.object_id !== objectId
  )
    throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
}
export async function productModelFetch(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  input: string | URL | Request,
  init?: RequestInit,
  execution?: CloudExecutionGrant,
  member?: CloudMemberModelProof,
) {
  const original = new Request(input, init);
  const raw = await original.text();
  const body = member
    ? JSON.stringify({ member, request: JSON.parse(raw) })
    : execution
      ? JSON.stringify({
          execution: executionRef(execution),
          request: JSON.parse(raw),
        })
      : raw;
  if (new TextEncoder().encode(body).byteLength > 196608)
    throw new CloudError(413, 'CLOUD_REQUEST_TOO_LARGE');
  return request(
    env,
    binding,
    objectId,
    `model/${crypto.randomUUID()}`,
    body,
    original.signal,
    member ? 150000 : 15000,
  );
}

export async function authorizeProductInput(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  input: CloudInput,
  native: {
    submission_id: number | null;
    status: 'missing' | 'queued' | 'placed' | 'done' | 'unanswered';
  },
  purpose: 'execute' | 'read' = 'execute',
) {
  if (binding.execution_authority !== 'miniclaw-product') return;
  if (!input.product_receipt_digest)
    throw new CloudError(409, 'CLOUD_PRODUCT_INPUT_UNAVAILABLE');
  const response = await requestJson(
    env,
    binding,
    objectId,
    'inputs',
    JSON.stringify({
      input,
      native,
      ...(purpose === 'read' ? { purpose } : {}),
    }),
  );
  if (!response.ok) {
    throw new CloudError(409, 'CLOUD_PRODUCT_INPUT_UNAVAILABLE');
  }
  const result = (response.value ?? {}) as {
    authorized?: boolean;
    request_id?: string;
    product_receipt_digest?: string;
  };
  if (
    !result.authorized ||
    result.request_id !== input.request_id ||
    result.product_receipt_digest !== input.product_receipt_digest
  )
    throw new CloudError(409, 'CLOUD_PRODUCT_INPUT_UNAVAILABLE');
}

export async function deliverProductResult(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  body: string,
  requestId: string,
) {
  const response = await requestJson(env, binding, objectId, 'results', body);
  if (!response.ok) {
    throw new CloudError(503, 'CLOUD_RESULT_DELIVERY_UNCONFIRMED');
  }
  const receipt = (response.value ?? {}) as {
    delivered?: boolean;
    request_id?: string;
  };
  if (receipt.delivered !== true || receipt.request_id !== requestId)
    throw new CloudError(503, 'CLOUD_RESULT_DELIVERY_UNCONFIRMED');
}

export async function authorizeProductControl(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  control: { id: string; digest: string; payload: string; state: string },
  purpose: 'execute' | 'read' = 'execute',
  execution?: CloudExecutionRef,
) {
  if (binding.execution_authority !== 'miniclaw-product')
    throw new CloudError(409, 'CLOUD_PRODUCT_CONTROL_UNAVAILABLE');
  const response = await requestJson(
    env,
    binding,
    objectId,
    'controls',
    JSON.stringify({
      ...control,
      ...(purpose === 'read' ? { purpose } : {}),
      ...(execution ? { execution } : {}),
    }),
  );
  if (!response.ok) {
    throw new CloudError(409, 'CLOUD_PRODUCT_CONTROL_UNAVAILABLE');
  }
  const receipt = (response.value ?? {}) as {
    authorized?: boolean;
    id?: string;
    digest?: string;
  };
  if (
    !receipt.authorized ||
    receipt.id !== control.id ||
    receipt.digest !== control.digest
  )
    throw new CloudError(409, 'CLOUD_PRODUCT_CONTROL_UNAVAILABLE');
}

export async function authorizeProductStop(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  fence: z.infer<typeof StopFenceSchema>,
  execution?: CloudExecutionRef,
) {
  const response = await requestJson(
    env,
    binding,
    objectId,
    'stop-policy',
    JSON.stringify({ fence, ...(execution ? { execution } : {}) }),
  );
  if (!response.ok) {
    throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
  }
  return z
    .object({
      authorized: z.literal(true),
      session_id: z.literal(binding.session_id),
      runtime_id: z.literal(binding.runtime_id),
      object_id: z.literal(objectId),
      fence_digest: z.literal(await digest(JSON.stringify(fence))),
      mode: z.enum(['suspended', 'cancelled']),
    })
    .strict()
    .parse(response.value);
}

/** Resume is execution authority, unlike the deliberately weaker stop proof. */
export async function authorizeProductHandoffResume(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  fence: z.infer<typeof HandoffFenceSchema>,
) {
  if (
    !binding.bot_handoff ||
    binding.execution_authority !== 'miniclaw-product'
  )
    throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_CHANGED');
  const response = await requestJson(
    env,
    binding,
    objectId,
    'policy',
    JSON.stringify({
      binding_digest: await bindingDigest(binding),
      gateway_origin: env.MINICLAW_CLOUD_ORIGIN,
      handoff_resume: fence,
    }),
  );
  if (!response.ok) throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_CHANGED');
  z.object({
    authorized: z.literal(true),
    runtime: z.literal('cloudflare-durable'),
    session_id: z.literal(binding.session_id),
    runtime_id: z.literal(binding.runtime_id),
    object_id: z.literal(objectId),
    fence_digest: z.literal(await digest(JSON.stringify(fence))),
  })
    .strict()
    .parse(response.value);
}

export async function deliverHandoffProgress(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  payload: string,
  revision: number,
) {
  const response = await requestJson(
    env,
    binding,
    objectId,
    'progress',
    payload,
  );
  if (!response.ok) throw new CloudError(503, 'CLOUD_PROGRESS_UNAVAILABLE');
  z.object({
    accepted: z.literal(true),
    handoff_id: z.literal(binding.bot_handoff!.handoff_id),
    revision: z.literal(revision),
    payload_digest: z.literal(await digest(payload)),
    last_revision: z.number().int().min(revision),
  })
    .strict()
    .parse(response.value);
}
