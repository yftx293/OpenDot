import path from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  type CallToolResult,
  type McpTransport,
} from '@earendil-works/pi-mcp';
import type {
  StoredMcpServerDefinition,
  StoredMcpServerSecrets,
} from './mcp-utils.js';
import {
  buildMcpCatalog,
  McpCallIntentSchema,
  mcpCanonicalJson,
  mcpDigest,
  PiMcpPolicySchema,
  type McpCatalogEntry,
  type McpCallIntent,
} from './mcp-contract.js';

import { McpDeliveryError } from './mcp-errors.js';
export { McpDeliveryError } from './mcp-errors.js';

type Startup = {
  owner_id: string;
  server_id: string;
  definition_digest: string;
};
export type McpDispatch = {
  intent: McpCallIntent;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
  /** Device-node transport may revalidate its live command lease after
   * catalog discovery and immediately before the synchronous dispatch fence. */
  beforeDispatch?(): Promise<void>;
  /** Trusted device-side adapter may replace a binary result with an
   * authorized attachment receipt before the bounded JSON check. */
  prepareResult?(result: CallToolResult): Promise<CallToolResult>;
  /** Synchronous live grant/lease/control check after all asynchronous validation. */
  recheck(): void;
  /** Persist the attempt before any tools/call bytes can leave this process. */
  markDispatched(): void;
};
export interface McpDispatchConnection {
  dispatch(call: McpDispatch): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** A single connection lifetime. Reconnect and side-effect retry are deliberately absent. */
export class ManagedMcpConnection {
  private readonly client = new McpClient({
    name: 'opendot-managed-mcp',
    version: '1',
    capabilities: {},
    requestTimeoutMs: 10000,
  });
  private readonly lifetime = new AbortController();
  private entries: readonly McpCatalogEntry[] = [];
  private readonly validators = new Map<
    string,
    { input: ValidateFunction; output?: ValidateFunction }
  >();
  private readonly dispatched = new Set<string>();
  private retired = false;
  private closed = false;
  private readyPromise?: Promise<readonly McpCatalogEntry[]>;
  private closePromise?: Promise<void>;
  private readonly snapshot: StoredMcpServerDefinition & StoredMcpServerSecrets;
  constructor(
    private readonly options: {
      ownerId: string;
      serverId: string;
      definition: StoredMcpServerDefinition & StoredMcpServerSecrets;
      /** Explicitly approved cwd and environment, never process.env or developer HOME. */
      cwd: string;
      authorizeStartup(scope: Startup): void;
      /** Device adaptation is supplied by the shared device channel, never a model URL. */
      deviceTransport?: (
        scope: Startup,
        signal: AbortSignal,
      ) => Promise<McpTransport>;
      /** Device-node process only: the paired node may launch its own
       * explicitly configured server, after the device-side startup check. */
      localDeviceNodeId?: string;
    },
  ) {
    this.options = { ...options };
    this.snapshot = JSON.parse(mcpCanonicalJson(options.definition));
    this.client.onError(() => {}); // Raw transport errors may contain secrets.
    this.client.onClose(() => {
      this.retired = true;
    });
    this.client.onNotification('notifications/tools/list_changed', () => {
      this.retired = true;
    });
  }

  ready(): Promise<readonly McpCatalogEntry[]> {
    this.readyPromise ??= this.start();
    return this.readyPromise;
  }
  isLive(): boolean {
    return !this.closed && !this.retired && this.readyPromise !== undefined;
  }

  private async start(): Promise<readonly McpCatalogEntry[]> {
    if (this.closed) throw new McpDeliveryError('not_sent');
    const config = this.snapshot;
    // Default-off must not start processes, open transports or read user config.
    if (!config.enabled || config.pi === undefined) return [];
    const policy = PiMcpPolicySchema.parse(config.pi);
    if (!policy.enabled || policy.tools.length === 0) return [];
    if (config.type === 'sse')
      throw new Error('Legacy SSE is unsupported by Pi MCP');
    if (!path.isAbsolute(this.options.cwd))
      throw new Error('MCP cwd must be explicit');
    const scope: Startup = {
      owner_id: this.options.ownerId,
      server_id: this.options.serverId,
      definition_digest: mcpDigest(config),
    };
    // Starting a stdio server is itself privileged, even before tools/call.
    this.options.authorizeStartup(scope);
    let transport: McpTransport;
    if (
      policy.location.kind === 'device' &&
      policy.location.node_id !== this.options.localDeviceNodeId
    ) {
      if (!this.options.deviceTransport)
        throw new Error('Device MCP channel unavailable');
      const pending = this.options.deviceTransport(scope, this.lifetime.signal);
      // A factory ignoring cancellation must never adopt a late transport.
      void pending.then(
        (late) => {
          if (this.closed || this.lifetime.signal.aborted)
            void late.close().catch(() => {});
        },
        () => {},
      );
      const startupSignal = AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(10000),
      ]);
      transport = await new Promise<McpTransport>((resolve, reject) => {
        const abort = () => {
          this.lifetime.abort();
          reject(new McpDeliveryError('not_sent'));
        };
        if (startupSignal.aborted) {
          abort();
          return;
        }
        startupSignal.addEventListener('abort', abort, { once: true });
        void pending
          .then(resolve, reject)
          .finally(() => startupSignal.removeEventListener('abort', abort));
      });
    } else if (config.type === 'http') {
      const endpoint = new URL(config.url ?? '');
      if (
        !['https:', 'http:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search
      )
        throw new Error('Unsupported MCP endpoint');
      transport = new StreamableHttpTransport({
        url: endpoint.href,
        headers: config.headers,
        openGetStream: false,
        reconnect: { maxRetries: 0 },
        maxMessageBytes: policy.location.kind === 'device' ? 6000000 : 262144,
        fetch: async (url, init) => {
          if (new URL(url.toString()).href !== endpoint.href)
            throw new McpDeliveryError('not_sent');
          const response = await fetch(url, { ...init, redirect: 'error' });
          if (!response.body) return response;
          // The client bounds SSE events but its JSON/error readers are not
          // bounded. Apply the same byte ceiling before any SDK body reader.
          const reader = response.body.getReader();
          let bytes = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  controller.close();
                  return;
                }
                bytes += next.value.byteLength;
                if (bytes > 262144) {
                  await reader.cancel();
                  controller.error(new Error('MCP response size exceeded'));
                } else controller.enqueue(next.value);
              } catch {
                controller.error(new Error('MCP response unavailable'));
              }
            },
            cancel: (reason) => reader.cancel(reason),
          });
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      });
    } else {
      if (!config.command || !path.isAbsolute(config.command))
        throw new Error('MCP executable must be an approved absolute path');
      transport = new StdioTransport({
        command: config.command,
        args: config.args,
        cwd: this.options.cwd,
        inheritEnv: false,
        env: config.env ?? {},
        stderr: 'pipe',
        maxMessageBytes: policy.location.kind === 'device' ? 6000000 : 262144,
        maxStderrBytes: 4096,
        closeTimeoutMs: 1000,
      });
    }
    try {
      if (this.closed) {
        await transport.close();
        throw new McpDeliveryError('not_sent');
      }
      this.options.authorizeStartup(scope);
      await this.client.connect(transport);
      const listed = await this.client.listTools({
        signal: this.lifetime.signal,
      });
      const entries = buildMcpCatalog({
        ownerId: this.options.ownerId,
        serverId: this.options.serverId,
        serverConfigDigest: scope.definition_digest,
        location: policy.location,
        listed,
        selected: policy.tools,
      });
      const ajv = new Ajv2020({
        strict: true,
        allErrors: false,
        validateFormats: false,
      });
      for (const entry of entries)
        this.validators.set(entry.identity.registered_name, {
          input: ajv.compile(entry.definition.inputSchema),
          ...(entry.definition.outputSchema
            ? { output: ajv.compile(entry.definition.outputSchema) }
            : {}),
        });
      if (this.retired || this.closed) throw new McpDeliveryError('not_sent');
      this.entries = entries;
      return entries;
    } catch (cause) {
      await this.close();
      throw new McpDeliveryError('not_sent', { cause });
    }
  }

  /** Only the host call ledger may invoke this after precise approval. */
  async dispatch(call: McpDispatch): Promise<CallToolResult> {
    const intent = McpCallIntentSchema.parse(call.intent);
    // Take a detached copy before any await; caller mutation cannot swap arguments.
    const args = JSON.parse(mcpCanonicalJson(call.arguments)) as Record<
      string,
      unknown
    >;
    const entries = await this.ready();
    const entry = entries.find(
      (item) => item.identity.registered_name === intent.registered_name,
    );
    const validator = this.validators.get(intent.registered_name);
    if (
      !entry ||
      !validator ||
      this.closed ||
      this.retired ||
      this.dispatched.has(intent.call_id)
    )
      throw new McpDeliveryError('not_sent');
    const { identity } = entry;
    if (
      intent.owner_id !== identity.owner_id ||
      intent.server_id !== identity.server_id ||
      intent.original_name !== identity.original_name ||
      intent.catalog_digest !== identity.catalog_digest ||
      intent.schema_digest !== identity.schema_digest ||
      intent.server_config_digest !== identity.server_config_digest ||
      mcpDigest(intent.location) !== mcpDigest(identity.location) ||
      mcpDigest(args) !== intent.arguments_digest ||
      !validator.input(args)
    )
      throw new McpDeliveryError('not_sent');
    // Re-list on this connection; a definition change retires the entire frozen catalog.
    const signal = AbortSignal.any([call.signal, this.lifetime.signal]);
    let current: readonly McpCatalogEntry[];
    try {
      current = buildMcpCatalog({
        ownerId: identity.owner_id,
        serverId: identity.server_id,
        serverConfigDigest: identity.server_config_digest,
        location: identity.location,
        listed: await this.client.listTools({ signal }),
        selected: [identity.original_name],
      });
    } catch {
      // Discovery has not dispatched tools/call. Retire this frozen catalog
      // and avoid exposing arbitrary upstream error text or credentials.
      this.retired = true;
      throw new McpDeliveryError('not_sent');
    }
    if (current[0]?.identity.catalog_digest !== identity.catalog_digest)
      this.retired = true;
    if (call.beforeDispatch) await call.beforeDispatch();
    if (
      this.closed ||
      this.retired ||
      this.dispatched.has(intent.call_id) ||
      signal.aborted ||
      Date.now() >= intent.expires_at
    )
      throw new McpDeliveryError('not_sent');
    call.recheck();
    this.dispatched.add(intent.call_id);
    call.markDispatched();
    try {
      let result = await this.client.callTool(identity.original_name, args, {
        signal,
      });
      if (
        result.isError ||
        (validator.output && !validator.output(result.structuredContent))
      )
        throw new McpDeliveryError('uncertain', { result });
      if (call.prepareResult) result = await call.prepareResult(result);
      mcpCanonicalJson(result); // Bound receipt before persistence/model adaptation.
      return result;
    } catch (cause) {
      // Error responses, timeout and invalid output do not prove absence of effects.
      throw cause instanceof McpDeliveryError
        ? cause
        : new McpDeliveryError('uncertain', { cause });
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.closePromise ??= this.client.close();
    return this.closePromise;
  }
}
