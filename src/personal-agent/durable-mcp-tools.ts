import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Type } from '@earendil-works/pi-ai';
import {
  defineTool,
  type GenerationHooks,
  type ConversationId,
  type TaskId,
} from '@earendil-works/pi-durable';
import type { CallToolResult } from '@earendil-works/pi-mcp';
import {
  MCP_CALL_MEMO,
  MCP_GENERATION_GRANTS_MEMO,
  McpCallIntentSchema,
  McpGenerationGrantSchema,
  McpGenerationGrantsSchema,
  indexMcpCatalog,
  mcpDigest,
  type McpCallIntent,
  type McpCatalogEntry,
  type McpGenerationGrant,
} from '../mcp-contract.js';
import { McpDeliveryError, type McpDispatchConnection } from '../mcp-client.js';
import {
  assertMemberCurrentControl,
  memberSessionLease,
  memberToolContext,
} from '../bot-groups/member-inbox-store.js';
import {
  requireProductRuntime,
  listProductInputs,
  type ProductInputPayload,
} from './product-runtime-store.js';
import { PiDurableRuntimeAdapter } from './durable-runtime.js';
import {
  executeMcpApproval,
  getMcpApproval,
  requestMcpApproval,
  type McpApproval,
  type McpCallAuthority,
} from './mcp-approval-store.js';
import { settleComputerCallApproval } from './computer-approval-flow.js';

function grantForIntent(intent: McpCallIntent): McpGenerationGrant {
  const {
    source,
    operation: _operation,
    call_id: _call,
    arguments_digest: _arguments,
    ...grant
  } = intent;
  return McpGenerationGrantSchema.parse({
    ...grant,
    ...(source.runtime === 'pi-durable' && source.member
      ? { member: source.member }
      : {}),
  });
}

/** Actual native ToolTask adapter. Configuration/consent belongs to the Host,
 * which supplies the already-approved catalog and a live grant checker. */
export function createDurableMcpTools(options: {
  sessionId: string;
  ownerId: string;
  dotId: string;
  workspaceJid: string;
  executionOwner: string;
  entries: readonly McpCatalogEntry[];
  adapter(): PiDurableRuntimeAdapter;
  connection(entry: McpCatalogEntry): McpDispatchConnection;
  grants(): readonly McpGenerationGrant[];
  authorizeCommon(): void;
  recheckGrant(grant: McpGenerationGrant): void;
  onApproval?(approval: McpApproval): Promise<void> | void;
  onDeviceImage?(intent: McpCallIntent, result: CallToolResult): boolean;
}) {
  const catalog = indexMcpCatalog(options.entries);
  const recheck = (intent: McpCallIntent) => {
    options.authorizeCommon();
    const runtime = requireProductRuntime(options.sessionId, options.ownerId);
    if (
      intent.source.runtime !== 'pi-durable' ||
      intent.session_id !== options.sessionId ||
      intent.owner_id !== options.ownerId ||
      intent.dot_id !== options.dotId ||
      intent.workspace_jid !== options.workspaceJid ||
      runtime.workspace_jid !== options.workspaceJid ||
      runtime.conversation_id !== intent.source.conversation_id ||
      runtime.runtime_kind !== 'pi-durable' ||
      runtime.state === 'blocked'
    )
      throw new Error('MCP Runtime authority unavailable');
    options.recheckGrant(grantForIntent(intent));
    const lease = memberSessionLease(options.sessionId);
    if (lease) {
      const context = memberToolContext(options.sessionId, {
        conversationId: intent.source.conversation_id as ConversationId,
        inputs: intent.source.inputs.map((input) => ({
          submissionId: input.submission_id,
          requestId: input.request_id,
          entryId: input.entry_id,
        })),
      });
      assertMemberCurrentControl(context);
      const expected = {
        lease_id: context.lease.id,
        run_id: context.run.id,
        grant_id: context.grant.id,
        cancel_epoch: context.run.cancel_epoch ?? 0,
        control_epoch: context.run.control_epoch ?? 0,
      };
      if (
        !intent.source.member ||
        mcpDigest(intent.source.member) !== mcpDigest(expected)
      )
        throw new Error('MCP member lease/control changed');
    } else if (intent.source.member)
      throw new Error('MCP member source unavailable');
  };
  const authority: McpCallAuthority = {
    verifySource: async (intent) => {
      recheck(intent);
      if (intent.source.runtime !== 'pi-durable')
        throw new Error('Native Durable MCP source required');
      const products = listProductInputs(intent.session_id);
      const bindings = intent.source.inputs.map((input) => {
        const product = products.find(
          (row) => row.request_id === input.request_id,
        );
        if (
          !product ||
          !['admitted', 'submitted'].includes(product.state) ||
          (product.submission_id !== null &&
            product.submission_id !== input.submission_id)
        )
          throw new Error('MCP source lacks an active Product Input receipt');
        const payload = JSON.parse(product.payload) as ProductInputPayload;
        return {
          requestId: product.request_id,
          binding: JSON.stringify({
            content: product.payload,
            whenBusy:
              payload.followUpBehavior === 'steer' ? 'steer' : 'followUp',
          }),
        };
      });
      await options.adapter().verifyMcpToolIntent(intent, bindings);
      recheck(intent);
    },
    recheck,
  };
  const beforeRequest: GenerationHooks['beforeRequest'] = async (
    _request,
    api,
    context,
  ) => {
    options.authorizeCommon();
    const grants = McpGenerationGrantsSchema.parse(options.grants());
    for (const grant of grants) {
      const entry = catalog.get(grant.registered_name);
      if (
        !entry ||
        grant.session_id !== options.sessionId ||
        grant.owner_id !== options.ownerId ||
        grant.dot_id !== options.dotId ||
        grant.workspace_jid !== options.workspaceJid ||
        entry.identity.server_id !== grant.server_id ||
        entry.identity.original_name !== grant.original_name ||
        entry.identity.catalog_digest !== grant.catalog_digest ||
        entry.identity.schema_digest !== grant.schema_digest ||
        entry.identity.server_config_digest !== grant.server_config_digest ||
        mcpDigest(entry.identity.location) !== mcpDigest(grant.location)
      )
        throw new Error('MCP generation grant/catalog conflict');
      options.recheckGrant(grant);
    }
    await api.memo(MCP_GENERATION_GRANTS_MEMO, grants, context);
    options.authorizeCommon();
    return undefined;
  };
  const tools = options.entries.map((entry) =>
    defineTool({
      name: entry.identity.registered_name,
      description:
        entry.definition.description ??
        `Call the approved MCP tool ${entry.identity.original_name}. Exact arguments require owner approval.`,
      parameters: Type.Unsafe<Record<string, unknown>>(
        entry.definition.inputSchema,
      ),
      // Native replay re-enters the persistent ledger, never tools/call directly.
      replay: 'safe',
      async execute(args, api, context) {
        options.authorizeCommon();
        const adapter = options.adapter(),
          source = await adapter.productToolSource(
            api.conversationId,
            api.taskId,
          );
        const generation = await api.getTask(
          source.generationTaskId as TaskId,
          context,
        );
        const grants = McpGenerationGrantsSchema.parse(
          generation?.memos?.[MCP_GENERATION_GRANTS_MEMO],
        );
        const grant = grants.find(
          (item) => item.registered_name === entry.identity.registered_name,
        );
        if (!grant)
          throw new Error('MCP was not granted to this native generation');
        const { member, ...base } = grant;
        const intent = McpCallIntentSchema.parse(
          await api.memo(
            MCP_CALL_MEMO,
            {
              ...base,
              operation: 'mcp.call',
              call_id: randomUUID(),
              arguments_digest: mcpDigest(args),
              source: {
                runtime: 'pi-durable',
                conversation_id: source.conversationId,
                tool_task_id: source.toolTaskId,
                generation_task_id: source.generationTaskId,
                ancestor_task_ids: await adapter.productToolAncestry(
                  api.conversationId,
                  api.taskId,
                ),
                call_id: api.callId,
                inputs: source.inputs.map((input) => ({
                  submission_id: input.submissionId,
                  request_id: input.requestId,
                  entry_id: input.entryId,
                })),
                ...(member ? { member } : {}),
              },
            },
            context,
          ),
        );
        const approval = await settleComputerCallApproval(
          await requestMcpApproval(intent, args, authority),
          args,
          authority,
        );
        await options.onApproval?.(approval);
        let current = approval;
        while (current.state === 'pending') {
          await delay(100, undefined, { signal: context.abortSignal });
          recheck(intent);
          current = getMcpApproval(intent.call_id, options.ownerId);
        }
        try {
          const result = await executeMcpApproval({
            id: intent.call_id,
            ownerId: options.ownerId,
            executionOwner: options.executionOwner,
            signal: context.abortSignal ?? new AbortController().signal,
            connection: options.connection(entry),
            authority,
          });
          const imageReady =
            intent.location.kind === 'device' &&
            options.onDeviceImage?.(intent, result) === true;
          return {
            output: modelOutput(
              result,
              intent.location.kind === 'device',
              imageReady,
            ),
            details: { callId: intent.call_id, state: 'completed' },
          };
        } catch (error) {
          if (context.abortSignal?.aborted) throw error;
          const state = getMcpApproval(intent.call_id, options.ownerId).state;
          return {
            isError: true,
            output: [
              {
                type: 'text' as const,
                text:
                  error instanceof McpDeliveryError
                    ? error.message
                    : state === 'completed'
                      ? 'MCP operation completed; result access is no longer authorized.'
                      : 'MCP call blocked; no verified completion receipt.',
              },
            ],
            details: {
              callId: intent.call_id,
              state,
            },
          };
        }
      },
    }),
  );
  const selectTools = () => {
    const grants = McpGenerationGrantsSchema.parse(options.grants());
    for (const grant of grants) options.recheckGrant(grant);
    const selected = new Set(grants.map((grant) => grant.registered_name));
    return tools.filter((tool) => selected.has(tool.name));
  };
  return { tools, selectTools, beforeRequest, authority };
}

function modelOutput(
  result: CallToolResult,
  device: boolean,
  imageReady: boolean,
): { type: 'text'; text: string }[] {
  const output: { type: 'text'; text: string }[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') output.push({ type: 'text', text: block.text });
    else
      output.push({
        type: 'text',
        text: `[MCP ${block.type} retained in the authorized call receipt; an approved content adapter is required.]`,
      });
  }
  if (
    device &&
    result.structuredContent &&
    typeof result.structuredContent === 'object' &&
    '__opendot_device_attachment' in result.structuredContent
  )
    output.push({
      type: 'text',
      text: imageReady
        ? '截图已安全接收；图片仅可能附于处理本次请求，不会保留在会话历史中。'
        : '截图已安全接收，但当前会话尚未启用图片模型输入，无法查看图片内容。',
    });
  if (!output.length && result.structuredContent !== undefined)
    output.push({
      type: 'text',
      text: JSON.stringify(result.structuredContent),
    });
  return output;
}
