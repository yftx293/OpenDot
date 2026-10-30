import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { BotGroupError } from '../bot-groups/protocol.js';
import {
  getDiscussion,
  endDiscussion,
} from '../bot-groups/discussion-store.js';
import { getBotHandoffService } from '../bot-groups/handoff-service.js';
import { logger } from '../logger.js';
import { CloudMemberModelProofSchema } from '../bot-groups/member-wire.js';
import {
  memberCloudExecution,
  memberToolContext,
  assertMemberGenerationBudget,
  type MemberModelFrame,
} from '../bot-groups/member-inbox-store.js';
import {
  acquireMemberModelAdmission,
  claimMemberCloudOwner,
  assertMemberCloudOwner,
  memberCloudOwnerKey,
} from '../bot-groups/member-model-store.js';
import {
  admitCloudModelAttempt,
  finishCloudModelAttempt,
} from './product-runtime-store.js';
import { assertCloudAuthority } from './cloud-authority.js';
import { CloudError, digest, type CloudScope } from './cloud-wire.js';
import { resolveProviderById } from '../runtime-config.js';
import { opencodeSessionHeaders } from './opencode-headers.js';
import type {
  ModelRequestAdmission,
  ModelRequestResult,
} from './metered-model-api.js';

/** Signed native-generation proof + existing Node admission ledger. No new
 * queue, native owner, provider credential in the DO, or peer-await lock. */
export async function proxyCloudMemberModel(
  scope: CloudScope,
  objectId: string,
  requestId: string,
  proofRaw: unknown,
  input: {
    model: string;
    max_tokens?: number;
    max_completion_tokens?: number;
    messages: unknown[];
    tools?: { function: { name: string } }[];
    tool_choice?: unknown;
  },
  signal: AbortSignal,
) {
  const proof = CloudMemberModelProofSchema.parse(proofRaw),
    source = {
      conversationId: ROOT_CONVERSATION_ID,
      inputs: proof.source.inputs,
    };
  let claimed = false;
  const authorize = () => {
    if (claimed) assertMemberCloudOwner(scope.session_id, proof.owner_revision);
    const authority = assertCloudAuthority(scope, objectId);
    const expected = memberCloudExecution(
      scope.session_id,
      proof.source.inputs[0].requestId,
    );
    if (
      !expected ||
      JSON.stringify(expected) !== JSON.stringify(proof.execution) ||
      !authority.binding.group_session ||
      authority.binding.group_session.group_id !== expected.group_id ||
      authority.binding.group_session.profile_id !== expected.profile_id
    )
      throw new CloudError(409, 'CLOUD_MEMBER_SOURCE_SCOPE_CONFLICT');
    return authority;
  };
  const authority = authorize(),
    context = memberToolContext(scope.session_id, source);
  if (input.model !== authority.binding.model_id)
    throw new CloudError(409, 'CLOUD_MODEL_BINDING_CHANGED');
  const allowed = new Set([
    ...proof.execution.tool_capabilities,
    'ask_group_dot',
    'read_group_context',
  ]);
  const names = input.tools?.map((t) => t.function.name) ?? [];
  const choice = input.tool_choice as
    | { function?: { name?: string } }
    | undefined;
  if (
    names.some((n) => !allowed.has(n)) ||
    new Set(names).size !== names.length ||
    (choice?.function?.name && !allowed.has(choice.function.name))
  )
    throw new CloudError(403, 'CLOUD_TOOL_NOT_GRANTED');
  const frame: MemberModelFrame = {
    lease_id: context.lease.id,
    run_id: context.run.id,
    cancel_epoch: context.lease.cancel_epoch,
    task_id: proof.source.generationTaskId,
    attempt: proof.source.attempt,
    context_digest: proof.context_digest,
    inputs: proof.source.inputs,
  };
  signal.throwIfAborted();
  claimMemberCloudOwner(
    scope.session_id,
    scope.runtime_id,
    objectId,
    proof.owner_revision,
    frame,
  );
  claimed = true;
  const control = new AbortController(),
    cancel = () => control.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const interval = setInterval(() => {
    try {
      authorize();
    } catch {
      cancel();
    }
  }, 1000);
  interval.unref();
  let timeout: ReturnType<typeof setTimeout> | undefined,
    permit: (ModelRequestAdmission & { id: string }) | undefined,
    admitted = false,
    settled = false;
  const settle = (result: ModelRequestResult) => {
    if (!settled && permit) {
      settled = true;
      permit.settle(result);
    }
  };
  try {
    if (proof.local_budget_exhausted) {
      // A signed local denial is diagnostic, never permission to infer. Only
      // the existing Authority ledger can establish the budget pause reason.
      assertMemberGenerationBudget(scope.session_id);
      throw new CloudError(409, 'CLOUD_MEMBER_MODEL_BUDGET_CONFLICT');
    }
    permit = await acquireMemberModelAdmission(
      scope.session_id,
      frame,
      {
        signal: control.signal,
        contextWindow: 128000,
        contextBytes: Buffer.byteLength(JSON.stringify(input)),
        maxOutputTokens:
          input.max_tokens ?? input.max_completion_tokens ?? 4096,
      },
      memberCloudOwnerKey(scope.runtime_id, proof.owner_revision),
    );
    const requestDigest = await digest(JSON.stringify({ proof, input }));
    control.signal.throwIfAborted();
    authorize();
    admitCloudModelAttempt(
      scope.session_id,
      requestId,
      requestDigest,
      undefined,
      permit,
    );
    admitted = true;
    timeout = setTimeout(
      cancel,
      Math.max(1, Math.min(60000, context.run.deadline_at - Date.now())),
    );
    timeout.unref();
    const provider = resolveProviderById(authority.model.id, {
        required: true,
      }),
      base = authority.model.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.config.anthropicApiKey || provider.config.anthropicAuthToken}`,
        'Content-Type': 'application/json',
        ...opencodeSessionHeaders(base, scope.session_id),
      },
      body: JSON.stringify({
        ...input,
        stream_options: { include_usage: true },
      }),
      signal: control.signal,
      redirect: 'error',
    });
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.startsWith('text/event-stream')
    ) {
      // An explicit client rejection belongs to the native model's error/retry
      // policy. Turning it into a transport outage repeatedly reopens the same
      // Cloud invocation and spends the member allowance without advancing its
      // native attempt. Never pass through the provider's private error body.
      const rejected =
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status);
      await response.body?.cancel();
      throw new CloudError(
        rejected ? 400 : 503,
        rejected ? 'CLOUD_MODEL_REQUEST_REJECTED' : 'CLOUD_MODEL_UNAVAILABLE',
      );
    }
    // Hold the bounded provider response until accounting commits. A finish
    // frame cannot publish success ahead of a failed usage transaction.
    const chunks: Uint8Array[] = [],
      reader = response.body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        control.signal.throwIfAborted();
        authorize();
        const { done, value } = await reader.read();
        control.signal.throwIfAborted();
        authorize();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024)
          throw new CloudError(413, 'CLOUD_MODEL_STREAM_LIMIT');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const data = Buffer.concat(chunks),
      frames = data.toString('utf8').split(/\r?\n\r?\n/);
    let terminal = false,
      finish: string | undefined,
      usage: ModelRequestResult['usage'];
    for (const [index, frame] of frames.slice(0, -1).entries()) {
      const text = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!text) continue;
      if (text.trim() === '[DONE]') {
        terminal = true;
        // A finish frame after the protocol terminator cannot complete the
        // response, or be forwarded to the consumer as additional content.
        if (frames.slice(index + 1).some((part) => /(?:^|\r?\n)data:/.test(part)))
          throw new CloudError(503, 'CLOUD_MODEL_INTERRUPTED');
        break;
      }
      const value = JSON.parse(text) as {
        choices?: { finish_reason?: string | null }[];
        usage?: Record<string, any>;
      };
      // Pi consumes only the first choice; a later choice cannot complete
      // the model answer or settle this member's accounting.
      const first = value.choices?.[0];
      if (typeof first?.finish_reason === 'string' && first.finish_reason) {
        finish = first.finish_reason;
        terminal = true;
      }
      if (value.usage) {
        const u = value.usage,
          p = u.prompt_tokens,
          o = u.completion_tokens,
          read =
            u.prompt_tokens_details?.cached_tokens ??
            u.prompt_cache_hit_tokens ??
            u.cached_tokens ??
            0,
          write = u.prompt_tokens_details?.cache_write_tokens ?? 0;
        if (
          [p, o, read, write].every((n) => Number.isSafeInteger(n) && n >= 0)
        ) {
          const input = Math.max(0, p - read - write);
          usage = {
            input,
            output: o,
            cacheRead: read,
            cacheWrite: write,
            totalTokens: Math.max(p + o, u.total_tokens ?? 0),
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          };
        }
      }
    }
    if (!terminal || !finish)
      throw new CloudError(503, 'CLOUD_MODEL_INTERRUPTED');
    control.signal.throwIfAborted();
    authorize();
    settle({
      kind: ['stop', 'tool_calls', 'function_call'].includes(finish)
        ? 'done'
        : 'error',
      usage,
    });
    finishCloudModelAttempt(scope.session_id, requestId, true);
    return new Response(data, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    let failure = error;
    try {
      settle({ kind: control.signal.aborted ? 'aborted' : 'error' });
    } catch (accountingError) {
      failure = accountingError;
    } finally {
      // Owner replacement/Stop may already have fenced this permit. The
      // independent transport ledger must still retain its uncertain result.
      if (admitted) finishCloudModelAttempt(scope.session_id, requestId, false);
    }
    if (failure instanceof BotGroupError) {
      if (
        [
          'GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED',
          'GROUP_MEMBER_TOKEN_BUDGET_EXHAUSTED',
          'GROUP_MEMBER_OWNER_BUDGET_EXHAUSTED',
          'GROUP_MEMBER_TOKEN_LIMIT_EXCEEDED',
          'GROUP_MEMBER_CAPACITY_WAIT_EXPIRED',
          'GROUP_MEMBER_MODEL_BACKPRESSURE',
          'GROUP_MEMBER_MODEL_CONTEXT_LIMIT',
        ].includes(failure.code)
      ) {
        const run = getDiscussion(frame.run_id);
        if (run?.status === 'running') {
          endDiscussion(run.id, 'waiting_user', failure.code);
          const service = getBotHandoffService();
          if (service)
            void service.discussions.stop(run.group_id, run.id).catch(() => {
              logger.warn(
                { sessionId: scope.session_id, runId: run.id },
                'Group budget stop remains pending',
              );
            });
        }
      }
      throw failure;
    }
    if (failure instanceof CloudError) throw failure;
    throw new CloudError(503, 'CLOUD_MEMBER_MODEL_INTERRUPTED');
  } finally {
    clearInterval(interval);
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
