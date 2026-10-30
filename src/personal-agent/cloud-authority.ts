import { proxyCloudMemberModel } from './cloud-member-model.js';
import {
  memberCloudExecution,
  memberSessionLease,
} from '../bot-groups/member-inbox-store.js';
import {
  CloudMemberExecutionSchema,
  CloudMemberModelProofSchema,
} from '../bot-groups/member-wire.js';
import { CloudHandoffFenceSchema } from './cloud-lifecycle.js';
import { assertBotHandoffAuthority } from '../bot-groups/handoff-store.js';
import { z } from 'zod';
import {
  DisabledModelConfiguration,
  resolveProviderById,
} from '../runtime-config.js';
import { getProductRuntimeService } from './product-runtime.js';
import { productModelConfiguration } from './product-model.js';
import { opencodeSessionHeaders } from './opencode-headers.js';
import {
  ProductRuntimeConflict,
  listProductInputs,
  isCancelledProductInput,
  type ProductInputPayload,
  getCloudPlacement,
  bindCloudObject,
  admitCloudModelAttempt,
  finishCloudModelAttempt,
  listQueueControls,
  requireCloudExecution,
  CloudExecutionRefSchema,
} from './product-runtime-store.js';
import {
  CloudError,
  bindingDigest,
  digest,
  type CloudBinding,
  type CloudScope,
  CLOUD_TOOL_CAPABILITIES,
  type CloudExecutionRef,
  executionGrantDigest,
} from './cloud-wire.js';

export function assertCloudAuthority(
  scope: CloudScope,
  objectId: string,
  provisioning = false,
  readOnly = false,
  executionRef?: CloudExecutionRef,
) {
  if (!/^[a-f0-9]{64}$/.test(objectId))
    throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
  let runtime;
  try {
    runtime = getProductRuntimeService().authorize(
      scope.session_id,
      scope.owner_user_id,
    );
  } catch (error) {
    if (error instanceof DisabledModelConfiguration)
      throw new CloudError(409, 'CLOUD_MODEL_DISABLED');
    if (error instanceof ProductRuntimeConflict)
      throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
    throw error;
  }
  assertBotHandoffAuthority(scope.session_id, { execute: !readOnly });
  const placement = getCloudPlacement(scope.session_id);
  if (
    !placement ||
    (placement.object_id !== objectId &&
      !(provisioning && placement.object_id === null))
  )
    throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
  if (runtime.conversation_id !== null && runtime.conversation_id !== 1)
    throw new CloudError(409, 'CLOUD_ROOT_BINDING_CONFLICT');
  const binding = JSON.parse(placement.binding_json) as CloudBinding;
  if ((runtime.goal_id ?? undefined) !== binding.goal_id)
    throw new CloudError(409, 'CLOUD_GOAL_BINDING_CONFLICT');
  if (
    (!binding.goal_id && executionRef) ||
    (binding.goal_id && !readOnly && !executionRef)
  )
    throw new CloudError(409, 'CLOUD_EXECUTION_GRANT_REQUIRED');
  const execution =
    executionRef &&
    requireCloudExecution(scope.session_id, executionRef, readOnly);
  const deadlineAt = execution?.deadline_at ?? binding.deadline_at;
  for (const name of [
    'owner_user_id',
    'workspace_jid',
    'session_id',
    'runtime_id',
    'config_fingerprint',
  ] as const)
    if (binding[name] !== scope[name])
      throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
  if (
    binding.execution_authority !== 'miniclaw-product' ||
    (!readOnly && deadlineAt <= Date.now())
  )
    throw new CloudError(409, 'CLOUD_EXECUTION_SUSPENDED');
  const model = productModelConfiguration(
    runtime.workspace_jid,
    runtime.provider_id,
  );
  if (
    model.api !== 'openai-completions' ||
    model.modelId !== binding.model_id ||
    model.id !== binding.provider_id ||
    model.fingerprint !== binding.config_fingerprint
  )
    throw new CloudError(409, 'CLOUD_MODEL_BINDING_CHANGED');
  return { runtime, placement, binding, model, execution, deadlineAt };
}
export async function cloudPolicy(
  scope: CloudScope,
  objectId: string,
  input: unknown,
) {
  const body = z
    .object({
      binding_digest: z.string().regex(/^[a-f0-9]{64}$/),
      gateway_origin: z.url(),
      purpose: z.enum(['execute', 'read']).optional(),
      handoff_resume: CloudHandoffFenceSchema.optional(),
      execution: CloudExecutionRefSchema.optional(),
      execution_grant_digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict()
    .parse(input);
  const { binding, placement, execution } = assertCloudAuthority(
    scope,
    objectId,
    true,
    body.purpose === 'read',
    body.execution,
  );
  if (
    body.binding_digest !== (await bindingDigest(binding)) ||
    body.gateway_origin !== placement.gateway_origin
  )
    throw new CloudError(409, 'CLOUD_IDENTITY_CONFLICT');
  if (
    (execution &&
      body.execution_grant_digest !==
        (await executionGrantDigest(execution))) ||
    (!execution && body.execution_grant_digest)
  )
    throw new CloudError(409, 'CLOUD_EXECUTION_GRANT_CONFLICT');
  if (body.handoff_resume) {
    const handoff = assertBotHandoffAuthority(scope.session_id, {
      execute: true,
    });
    if (
      body.purpose === 'read' ||
      body.execution ||
      !binding.bot_handoff ||
      !handoff ||
      handoff.state !== 'pending' ||
      body.handoff_resume.handoff_id !== handoff.id ||
      body.handoff_resume.handoff_revision !== handoff.revision
    )
      throw new CloudError(409, 'CLOUD_HANDOFF_RESUME_CHANGED');
  }
  bindCloudObject(scope.session_id, scope.runtime_id, objectId);
  return {
    authorized: true,
    object_id: objectId,
    runtime: 'cloudflare-durable',
    session_id: binding.session_id,
    runtime_id: binding.runtime_id,
    ...(body.handoff_resume
      ? {
          fence_digest: await digest(JSON.stringify(body.handoff_resume)),
        }
      : {}),
  };
}
const RequestSchema = z
  .object({
    model: z.string().min(1).max(200),
    stream: z.literal(true),
    messages: z.array(z.unknown()).min(1).max(2000),
    tools: z
      .array(
        z
          .object({
            type: z.literal('function'),
            function: z
              .object({
                name: z.enum(CLOUD_TOOL_CAPABILITIES),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(3)
      .optional(),
    max_tokens: z.number().int().min(1).max(4096).optional(),
    max_completion_tokens: z.number().int().min(1).max(4096).optional(),
    store: z.literal(false).optional(),
    stream_options: z
      .object({ include_usage: z.boolean() })
      .strict()
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    prompt_cache_key: z.string().max(256).optional(),
    prompt_cache_retention: z.literal('24h').optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z
          .object({
            type: z.literal('function'),
            function: z
              .object({
                name: z.enum(CLOUD_TOOL_CAPABILITIES),
              })
              .strict(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
const memberNames = [
  ...CLOUD_TOOL_CAPABILITIES,
  'ask_group_dot',
  'read_group_context',
] as const;
const MemberRequestSchema = RequestSchema.extend({
  tools: z
    .array(
      z
        .object({
          type: z.literal('function'),
          function: z.object({ name: z.enum(memberNames) }).passthrough(),
        })
        .passthrough(),
    )
    .max(6)
    .optional(),
  tool_choice: z
    .union([
      z.enum(['auto', 'none', 'required']),
      z
        .object({
          type: z.literal('function'),
          function: z.object({ name: z.enum(memberNames) }).strict(),
        })
        .strict(),
    ])
    .optional(),
});
export async function proxyCloudModel(
  scope: CloudScope,
  objectId: string,
  requestId: string,
  raw: string,
  signal: AbortSignal,
) {
  z.uuid().parse(requestId);
  const decoded = JSON.parse(raw);
  // The versioned envelope stays recognizable after its lease is retired.
  // A late signed member request must reach execution fencing, rather than
  // being reinterpreted as an unrelated legacy/private model request.
  const memberEnvelope =
    decoded !== null &&
    typeof decoded === 'object' &&
    Object.hasOwn(decoded, 'member');
  if (memberSessionLease(scope.session_id) || memberEnvelope) {
    const input = z
      .object({
        member: CloudMemberModelProofSchema,
        request: MemberRequestSchema,
      })
      .strict()
      .parse(decoded);
    return proxyCloudMemberModel(
      scope,
      objectId,
      requestId,
      input.member,
      input.request,
      signal,
    );
  }
  const managed = assertCloudAuthority(scope, objectId, false, true).binding
    .goal_id;
  const envelope = managed
    ? z
        .object({ execution: CloudExecutionRefSchema, request: RequestSchema })
        .strict()
        .parse(decoded)
    : undefined;
  const input = envelope?.request ?? RequestSchema.parse(decoded);
  const execution = envelope?.execution;
  const authorize = () =>
    assertCloudAuthority(scope, objectId, false, false, execution);
  let authority = authorize();
  if (
    authority.runtime.state !== 'ready' ||
    authority.runtime.conversation_id !== 1
  )
    throw new CloudError(409, 'CLOUD_PROVISIONING_INCOMPLETE');
  if (input.model !== authority.binding.model_id)
    throw new CloudError(409, 'CLOUD_MODEL_BINDING_CHANGED');
  const allowedTools = new Set([
    ...(authority.binding.bot_handoff || authority.binding.group_session
      ? []
      : ['inspect_text']),
    ...(authority.binding.tool_capabilities ?? []),
  ]);
  const toolNames = input.tools?.map((tool) => tool.function.name) ?? [];
  if (
    toolNames.some((name) => !allowedTools.has(name)) ||
    new Set(toolNames).size !== toolNames.length ||
    (typeof input.tool_choice === 'object' &&
      !allowedTools.has(input.tool_choice.function.name))
  )
    throw new CloudError(403, 'CLOUD_TOOL_NOT_GRANTED');
  if (!input.max_tokens && !input.max_completion_tokens)
    input.max_tokens = 4096;
  // Endpoint and credentials are resolved by the existing encrypted Provider
  // store. No caller URL/header, model key or provider secret is returned to DO.
  const provider = resolveProviderById(authority.model.id, { required: true });
  const base = authority.model.baseUrl.replace(/\/$/, '');
  const control = new AbortController();
  const cancel = () => control.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) control.abort();
  const timer = setInterval(() => {
    try {
      authority = authorize();
    } catch {
      control.abort();
    }
  }, 1000);
  timer.unref();
  const timeout = setTimeout(
    cancel,
    Math.max(1, Math.min(60000, authority.deadlineAt - Date.now())),
  );
  timeout.unref();
  let finished = false;
  const cleanup = (completed: boolean) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    finishCloudModelAttempt(scope.session_id, requestId, completed);
  };
  try {
    const requestDigest = await digest(raw);
    control.signal.throwIfAborted();
    authorize();
    admitCloudModelAttempt(
      scope.session_id,
      requestId,
      requestDigest,
      execution,
    );
  } catch (error) {
    clearInterval(timer);
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    throw error;
  }
  control.signal.addEventListener('abort', () => cleanup(false), {
    once: true,
  });
  if (control.signal.aborted) {
    cleanup(false);
    throw new CloudError(503, 'CLOUD_MODEL_INTERRUPTED');
  }
  let response: Response;
  try {
    authorize();
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.config.anthropicApiKey || provider.config.anthropicAuthToken}`,
        'Content-Type': 'application/json',
        ...opencodeSessionHeaders(base, scope.session_id),
      },
      body: JSON.stringify(input),
      signal: control.signal,
      redirect: 'error',
    });
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.startsWith('text/event-stream')
    ) {
      await response.body?.cancel();
      throw new Error('Provider unavailable');
    }
  } catch {
    control.abort();
    cleanup(false);
    throw new CloudError(503, 'CLOUD_MODEL_UNAVAILABLE');
  }
  const reader = response.body!.getReader();
  let bytes = 0;
  let pending = '',
    terminal = false;
  const decoder = new TextDecoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        control.signal.throwIfAborted();
        authorize();
        const { done, value } = await reader.read();
        control.signal.throwIfAborted();
        authorize();
        if (done) {
          if (!terminal) throw new Error('Model stream ended before finish');
          cleanup(true);
          controller.close();
          return;
        }
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error('Model stream limit');
        pending += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(pending);
          if (!boundary) break;
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data.trim() === '[DONE]') {
            if (!terminal) throw new Error('Model stream ended before finish');
          } else if (data) {
            try {
              const parsed = JSON.parse(data) as {
                choices?: { finish_reason?: unknown }[];
              };
              if (
                Array.isArray(parsed.choices) &&
                typeof parsed.choices[0]?.finish_reason === 'string' &&
                parsed.choices[0].finish_reason.length > 0
              )
                terminal = true;
            } catch {
              // The provider parser is responsible for malformed frames.
            }
          }
        }
        controller.enqueue(value);
      } catch {
        control.abort();
        await reader.cancel().catch(() => {});
        cleanup(false);
        controller.error(new CloudError(503, 'CLOUD_MODEL_INTERRUPTED'));
      }
    },
    async cancel() {
      control.abort();
      await reader.cancel().catch(() => {});
      cleanup(false);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const InputProofSchema = z
  .object({
    purpose: z.enum(['execute', 'read']).optional(),
    input: z
      .object({
        request_id: z.string().min(1).max(128),
        content: z.string().min(1).max(32768),
        when_busy: z.enum(['followUp', 'steer']),
        product_receipt_digest: z.string().regex(/^[a-f0-9]{64}$/),
        execution: CloudExecutionRefSchema.optional(),
        member: CloudMemberExecutionSchema.optional(),
      })
      .strict(),
    native: z
      .object({
        submission_id: z.number().int().positive().nullable(),
        status: z.enum(['missing', 'queued', 'placed', 'done', 'unanswered']),
      })
      .strict(),
  })
  .strict();
export async function cloudInputPolicy(
  scope: CloudScope,
  objectId: string,
  body: unknown,
) {
  const proof = InputProofSchema.parse(body);
  const { binding, runtime } = assertCloudAuthority(
    scope,
    objectId,
    false,
    proof.purpose === 'read',
    proof.input.execution,
  );
  if (binding.goal_id && !proof.input.execution)
    throw new CloudError(409, 'CLOUD_EXECUTION_GRANT_REQUIRED');
  if (runtime.state !== 'ready' || runtime.conversation_id !== 1)
    throw new CloudError(409, 'CLOUD_PROVISIONING_INCOMPLETE');
  const row = listProductInputs(scope.session_id).find(
    (input) => input.request_id === proof.input.request_id,
  );
  if (
    !row ||
    row.payload_digest !== proof.input.product_receipt_digest ||
    (await digest(row.payload)) !== row.payload_digest ||
    (isCancelledProductInput(row) && proof.native.status !== 'unanswered')
  )
    throw new CloudError(409, 'CLOUD_PRODUCT_INPUT_UNAVAILABLE');
  const payload = JSON.parse(row.payload) as ProductInputPayload;
  if (
    JSON.stringify(proof.input.member ?? null) !==
    JSON.stringify(
      memberCloudExecution(
        scope.session_id,
        row.request_id,
        proof.purpose === 'read',
      ) ?? null,
    )
  )
    throw new CloudError(409, 'CLOUD_MEMBER_INPUT_CONFLICT');
  if (
    payload.sender !== binding.owner_user_id ||
    payload.content !== proof.input.content ||
    (payload.followUpBehavior === 'steer' ? 'steer' : 'followUp') !==
      proof.input.when_busy ||
    JSON.stringify(
      payload.execution
        ? {
            goal_id: payload.execution.goalId,
            run_id: payload.execution.runId,
            context_digest: payload.execution.contextDigest,
          }
        : null,
    ) !== JSON.stringify(proof.input.execution ?? null) ||
    (proof.native.status === 'missing') !==
      (proof.native.submission_id === null) ||
    (row.submission_id !== null &&
      row.submission_id !== proof.native.submission_id) ||
    (row.state === 'completed' && proof.native.status !== 'done') ||
    (row.state === 'failed' && proof.native.status !== 'unanswered')
  )
    throw new CloudError(409, 'CLOUD_PRODUCT_INPUT_CONFLICT');
  assertCloudAuthority(
    scope,
    objectId,
    false,
    proof.purpose === 'read',
    proof.input.execution,
  );
  return {
    authorized: true,
    request_id: row.request_id,
    product_receipt_digest: row.payload_digest,
  };
}

export async function cloudResult(
  scope: CloudScope,
  objectId: string,
  body: unknown,
) {
  const result = InputProofSchema.extend({
    result: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('done'),
          answer_entry_id: z.number().int().positive(),
          task_id: z.number().int().positive().optional(),
          text: z.string().max(131072),
        })
        .strict(),
      z.object({ status: z.literal('unanswered') }).strict(),
    ]),
  })
    .strict()
    .parse(body);
  if (
    result.native.status !== result.result.status ||
    result.native.submission_id === null
  )
    throw new CloudError(409, 'CLOUD_RESULT_CONFLICT');
  // A late durable result may be delivered after its execution budget expired.
  // Read authority does not allow another model request or tool execution.
  await cloudInputPolicy(scope, objectId, {
    input: result.input,
    native: result.native,
    purpose: 'read',
  });
  await getProductRuntimeService().recordCloudResult(
    scope.session_id,
    result.input.request_id,
    result.native.submission_id,
    result.result,
  );
  return { delivered: true, request_id: result.input.request_id };
}

export async function cloudControlPolicy(
  scope: CloudScope,
  objectId: string,
  body: unknown,
) {
  const proof = z
    .object({
      id: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      payload: z.string().max(65536),
      state: z.enum(['pending', 'applied', 'rejected']),
      purpose: z.enum(['execute', 'read']).optional(),
      execution: CloudExecutionRefSchema.optional(),
    })
    .strict()
    .parse(body);
  const { runtime } = assertCloudAuthority(
    scope,
    objectId,
    false,
    proof.purpose === 'read',
    proof.execution,
  );
  if (runtime.state !== 'ready' || runtime.conversation_id !== 1)
    throw new CloudError(409, 'CLOUD_PROVISIONING_INCOMPLETE');
  const row = listQueueControls(scope.session_id).find(
    (row) => row.id === proof.id,
  );
  if (
    !row ||
    row.payload !== proof.payload ||
    row.payload_digest !== proof.digest ||
    (await digest(row.payload)) !== row.payload_digest ||
    (row.state !== 'pending' && row.state !== proof.state)
  )
    throw new CloudError(409, 'CLOUD_CONTROL_UNAVAILABLE');
  const prepared = JSON.parse(row.payload) as { goalRunId?: string };
  if ((prepared.goalRunId ?? undefined) !== proof.execution?.run_id)
    throw new CloudError(409, 'CLOUD_CONTROL_EXECUTION_CONFLICT');
  return { authorized: true, id: row.id, digest: row.payload_digest };
}
