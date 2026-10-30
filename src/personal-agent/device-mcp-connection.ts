import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { CallToolResult } from '@earendil-works/pi-mcp';
import {
  McpDeliveryError,
  type McpDispatch,
  type McpDispatchConnection,
} from '../mcp-client.js';
import {
  McpCatalogToolSchema,
  indexMcpCatalog,
  mcpDigest,
  registeredName,
  type McpCatalogEntry,
} from '../mcp-contract.js';
import { openHostPrivateJson } from '../runtime-config.js';
import {
  createDeviceMcpCommand,
  createDeviceMcpStartupCommand,
  getDeviceCommand,
  cancelDeviceCommand,
  validateDeviceMcpGrant,
  validateDeviceMcpStartup,
} from './device-store.js';
import {
  DeviceMcpBindingSchema,
  DeviceMcpResultSchema,
  DeviceMcpStartupResultSchema,
  deviceDigest,
  deviceTextDigest,
  type DeviceMcpStartupBinding,
} from './device-protocol.js';

/** Authority-side adapter. The existing command ledger transports the exact
 * approved MCP identity; parameters stay in the encrypted approval record. */
export class DeviceMcpConnection implements McpDispatchConnection {
  private closed = false;
  private catalog: McpCatalogEntry[] = [];
  constructor(
    private readonly startup: DeviceMcpStartupBinding,
    private readonly authorize: () => void,
  ) {}

  private async receipt(
    id: string,
    deadline: number,
    signal?: AbortSignal,
    recheck?: () => void,
  ): Promise<unknown> {
    for (;;) {
      try {
        this.authorize();
        recheck?.();
      } catch {
        // A dispatched operation may already have taken effect. Fence queued
        // delivery and report uncertainty rather than replaying it.
        cancelDeviceCommand(id, 'mcp_authority_lost');
        throw new McpDeliveryError('uncertain');
      }
      if (this.closed || signal?.aborted || Date.now() >= deadline) {
        cancelDeviceCommand(id, 'mcp_wait_cancelled');
        throw new McpDeliveryError('uncertain');
      }
      const row = getDeviceCommand(id);
      if (!row) throw new McpDeliveryError('uncertain');
      if (row.state === 'cancelled') throw new McpDeliveryError('uncertain');
      if (row.state === 'completed' || row.state === 'failed') {
        const envelope = z
          .object({ sealed: z.string() })
          .strict()
          .parse(JSON.parse(row.result ?? '{}'));
        const result = openHostPrivateJson(
          {
            ownerId: this.startup.owner_id,
            recordId: id,
            purpose: 'mcp.call.result',
          },
          envelope.sealed,
        );
        if (deviceDigest(result) !== row.result_digest)
          throw new McpDeliveryError('uncertain');
        return result;
      }
      await delay(100, undefined, { signal }).catch(() => {
        // Abort can arrive during the wait, before the next loop can observe
        // it. Cancel the command immediately so it cannot be leased later.
        cancelDeviceCommand(id, 'mcp_wait_cancelled');
        throw new McpDeliveryError('uncertain');
      });
    }
  }

  async ready(): Promise<readonly McpCatalogEntry[]> {
    this.authorize();
    validateDeviceMcpStartup(this.startup);
    createDeviceMcpStartupCommand(this.startup);
    const result = DeviceMcpStartupResultSchema.parse(
      await this.receipt(
        this.startup.id,
        Math.min(this.startup.expires_at, Date.now() + 30000),
        undefined,
        () => { validateDeviceMcpStartup(this.startup); },
      ),
    );
    if (
      result.outcome !== 'completed' ||
      deviceTextDigest(result.catalog) !== result.catalog_digest
    )
      throw new McpDeliveryError('uncertain');
    const raw = z
      .array(
        z
          .object({
            identity: z
              .object({
                version: z.literal(1),
                owner_id: z.string(),
                server_id: z.string(),
                original_name: z.string(),
                registered_name: z.string(),
                catalog_digest: z.string().regex(/^[a-f0-9]{64}$/),
                schema_digest: z.string().regex(/^[a-f0-9]{64}$/),
                server_config_digest: z.string().regex(/^[a-f0-9]{64}$/),
                location: z
                  .object({ kind: z.literal('device'), node_id: z.uuid() })
                  .strict(),
              })
              .strict(),
            definition: McpCatalogToolSchema,
          })
          .strict(),
      )
      .max(50)
      .parse(JSON.parse(result.catalog));
    const tools = [...this.startup.tools].sort();
    if (
      mcpDigest(raw.map((e) => e.identity.original_name).sort()) !==
      mcpDigest(tools)
    )
      throw new McpDeliveryError('uncertain');
    const digests = new Set<string>();
    for (const entry of raw) {
      const i = entry.identity;
      if (
        i.owner_id !== this.startup.owner_id ||
        i.server_id !== this.startup.server_id ||
        i.location.node_id !== this.startup.node_id ||
        i.original_name !== entry.definition.name ||
        i.registered_name !== registeredName(i.server_id, i.original_name) ||
        i.server_config_digest !== this.startup.configuration_digest ||
        i.schema_digest !==
          mcpDigest({
            input: entry.definition.inputSchema,
            output: entry.definition.outputSchema ?? null,
          })
      )
        throw new McpDeliveryError('uncertain');
      digests.add(i.catalog_digest);
    }
    if (digests.size !== 1) throw new McpDeliveryError('uncertain');
    indexMcpCatalog(raw);
    this.catalog = raw;
    return this.catalog;
  }

  async dispatch(call: McpDispatch): Promise<CallToolResult> {
    const i = call.intent;
    if (
      this.closed ||
      i.location.kind !== 'device' ||
      i.location.node_id !== this.startup.node_id ||
      i.grant_id !== this.startup.consent_id ||
      !this.catalog.some(
        (entry) =>
          entry.identity.registered_name === i.registered_name &&
          entry.identity.schema_digest === i.schema_digest &&
          entry.identity.catalog_digest === i.catalog_digest,
      ) ||
      mcpDigest(call.arguments) !== i.arguments_digest ||
      call.signal.aborted
    )
      throw new McpDeliveryError('not_sent');
    const binding = DeviceMcpBindingSchema.parse({
      version: 2,
      capability: 'mcp',
      id: i.call_id,
      owner_id: i.owner_id,
      workspace_jid: i.workspace_jid,
      session_id: i.session_id,
      dot_id: i.dot_id,
      node_id: i.location.node_id,
      grant_id: i.grant_id,
      device_grant_id: this.startup.device_grant_id,
      grant_revision: i.grant_revision,
      cancel_generation: i.cancel_generation,
      manifest_hash: this.startup.manifest_hash,
      server_id: i.server_id,
      configuration_digest: i.server_config_digest,
      catalog_digest: i.catalog_digest,
      schema_digest: i.schema_digest,
      tool_name: i.original_name,
      call_id: i.call_id,
      args_digest: i.arguments_digest,
      expires_at: i.expires_at,
      intent: i,
    });
    this.authorize();
    validateDeviceMcpGrant(binding);
    call.recheck();
    call.markDispatched();
    createDeviceMcpCommand(binding);
    const result = DeviceMcpResultSchema.parse(
      await this.receipt(
        binding.id,
        Math.min(binding.expires_at, Date.now() + 30000),
        call.signal,
        () => {
          call.recheck();
          validateDeviceMcpGrant(binding);
        },
      ),
    );
    if (
      result.outcome !== 'completed' ||
      deviceTextDigest(result.content) !== result.content_digest
    )
      throw new McpDeliveryError('uncertain');
    const parsed = z
      .object({
        content: z.array(
          z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
        ),
      })
      .strict()
      .parse(JSON.parse(result.content));
    call.recheck();
    validateDeviceMcpGrant(binding);
    return result.attachment
      ? {
          ...parsed,
          structuredContent: {
            __opendot_device_attachment: {
              command_id: binding.id,
              digest: result.attachment.digest,
              size: result.attachment.size,
              mime: result.attachment.mime,
              expires_at: result.attachment.expires_at,
            },
          },
        }
      : parsed;
  }
  async close() {
    this.closed = true;
  }
}
