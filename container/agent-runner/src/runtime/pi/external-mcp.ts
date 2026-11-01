import { setTimeout as delay } from 'node:timers/promises';
import {
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { z } from 'zod';
import { callExternalMcpHost, type McpContext } from '../../mcp-tools.js';
import { mcpWaitVerdict } from './mcp-wait-budget.js';

const CatalogSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .regex(/^mcp__[A-Za-z0-9_-]{1,59}$/)
          .refine((v) => !v.startsWith('mcp__miniclaw__')),
        description: z.string().max(16384),
        inputSchema: z
          .record(z.string(), z.unknown())
          .refine((v) => v.type === 'object'),
        grant_id: z.uuid(),
        schema_digest: z.string().regex(/^[a-f0-9]{64}$/),
        catalog_digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  )
  .max(100)
  .refine(
    (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
  );

/** Host only returns a catalog after explicit session consent. The runner
 * cannot construct a grant, choose a server location, or call it directly. */
export async function loadExternalMcpTools(
  ctx: McpContext,
): Promise<ToolDefinition[]> {
  if (
    (!ctx.codingMcpEnabled &&
      ctx.workspaceMemoryMutationAuth?.agentId != null) ||
    !ctx.workspaceMemoryMutationAuth ||
    !ctx.currentInputTurnId ||
    ctx.currentTaskId
  )
    return [];
  const response = await callExternalMcpHost(ctx, 'catalog', {}, 20000);
  const tools = CatalogSchema.parse(response.tools);
  return tools.map((entry) =>
    defineTool({
      name: entry.name,
      label: entry.name,
      description: entry.description,
      parameters: Type.Unsafe<Record<string, unknown>>(entry.inputSchema),
      execute: async (toolCallId, args, signal) => {
        const turnId = ctx.currentInputTurnId;
        const sessionId = ctx.currentSessionId;
        if (!turnId || ctx.currentTaskId)
          throw new Error('External MCP turn unavailable');
        const submitted = await callExternalMcpHost(ctx, 'submit', {
          tool_name: entry.name,
          grant_id: entry.grant_id,
          schema_digest: entry.schema_digest,
          catalog_digest: entry.catalog_digest,
          tool_call_id: toolCallId,
          arguments: args,
        });
        const callId = z.uuid().parse(submitted.call_id);
        const approvalStartedAt = Date.now();
        let executionStartedAt: number | null = null;
        let timedOut = false;
        try {
          while (!signal?.aborted) {
            if (
              ctx.currentInputTurnId !== turnId ||
              (sessionId && ctx.currentSessionId !== sessionId) ||
              ctx.currentTaskId
            )
              throw new Error('External MCP turn changed');
            const result = await callExternalMcpHost(ctx, 'status', {
              call_id: callId,
            });
            if (result.state === 'completed') {
              const content = z
                .array(
                  z
                    .object({
                      type: z.literal('text'),
                      text: z.string().max(65536),
                    })
                    .strict(),
                )
                .max(50)
                .parse(result.content);
              return { content, details: { callId, state: 'completed' } };
            }
            const state = String(result.state);
            if (!['pending', 'approved', 'dispatching'].includes(state))
              throw new Error(
                'External MCP call failed or has an uncertain outcome',
              );
            const now = Date.now();
            if (state !== 'pending') executionStartedAt ??= now;
            const verdict = mcpWaitVerdict({
              state,
              now,
              approvalStartedAt,
              executionStartedAt,
            });
            if (verdict === 'approval_timeout') {
              timedOut = true;
              throw new Error(
                'approval_timeout: The person did not confirm in time. Ask them, or continue without this computer action.',
              );
            }
            if (verdict === 'execution_timeout') {
              timedOut = true;
              throw new Error(
                'timeout: The computer operation timed out after it was allowed to run. Observe the window once before deciding whether to retry.',
              );
            }
            await delay(500, undefined, { signal });
          }
          throw new Error('External MCP call cancelled or timed out');
        } finally {
          if (signal?.aborted || timedOut || ctx.currentInputTurnId !== turnId)
            await callExternalMcpHost(ctx, 'cancel', { call_id: callId }).catch(
              () => undefined,
            );
        }
      },
    }),
  );
}
