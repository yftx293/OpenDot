import type Database from 'better-sqlite3';
import { ManagedMcpConnection, McpDeliveryError } from '../mcp-client.js';
import { mcpCanonicalJson, mcpDigest } from '../mcp-contract.js';
import type {
  StoredMcpServerDefinition,
  StoredMcpServerSecrets,
} from '../mcp-utils.js';
import { executeDeviceMcpOnce } from './device-local.js';
import { normalizeScreenshotImage } from './device-screenshot.js';
import {
  DeviceMcpBindingSchema,
  DeviceMcpManifestSchema,
  deviceDigest,
  deviceTextDigest,
  type DeviceMcpBinding,
  type DeviceMcpResult,
} from './device-protocol.js';

/** The pairing manifest is created before the Authority assigns a node ID.
 * Normalize just that ID so the owner can declare the same local definition
 * before pairing; the full configuration digest is still bound to each call. */
export function deviceMcpDeclarationDigest(
  definition: StoredMcpServerDefinition & StoredMcpServerSecrets,
  cwd: string,
) {
  if (definition.pi?.location.kind !== 'device')
    throw new Error('Device MCP placement required');
  return mcpDigest({
    cwd,
    definition: {
      ...definition,
      pi: { ...definition.pi, location: { kind: 'device' } },
    },
  });
}

/** Runs only in the paired device process. The configuration is local and
 * selected by the owner; a remote caller cannot supply an executable, endpoint,
 * environment or credentials. The authority callback must check the current
 * grant, approval, cancellation generation and target policy synchronously. */
export class LocalDeviceMcpServer {
  private readonly connection: ManagedMcpConnection;
  private readonly manifestHash: string;
  private readonly configurationDigest: string;
  private readonly nodeId: string;
  private readonly serverId: string;
  private readonly ownerId: string;

  constructor(
    private readonly options: {
      database: Database.Database;
      nodeId: string;
      ownerId: string;
      serverId: string;
      manifest: unknown;
      definition: StoredMcpServerDefinition & StoredMcpServerSecrets;
      cwd: string;
      allowedTools: readonly string[];
      authorizeStartup(): void;
      authorizeCall(binding: DeviceMcpBinding): void;
    },
  ) {
    const manifest = DeviceMcpManifestSchema.parse(options.manifest);
    const definition = JSON.parse(
      mcpCanonicalJson(options.definition),
    ) as StoredMcpServerDefinition & StoredMcpServerSecrets;
    this.nodeId = options.nodeId;
    this.ownerId = options.ownerId;
    this.serverId = options.serverId;
    this.manifestHash = deviceDigest(manifest);
    this.configurationDigest = mcpDigest(definition);
    if (
      definition.pi?.location.kind !== 'device' ||
      definition.pi.location.node_id !== options.nodeId ||
      options.allowedTools.length === 0 ||
      options.allowedTools.some(
        (name) => !definition.pi!.tools.includes(name),
      ) ||
      !manifest.servers.some(
        (s) =>
          s.server_id === options.serverId &&
          s.configuration_digest ===
            deviceMcpDeclarationDigest(definition, options.cwd),
      )
    )
      throw new Error('Device MCP local configuration is not declared');
    this.connection = new ManagedMcpConnection({
      ownerId: options.ownerId,
      serverId: options.serverId,
      definition,
      cwd: options.cwd,
      localDeviceNodeId: options.nodeId,
      authorizeStartup: () => options.authorizeStartup(),
    });
  }

  /** Explicit startup consent is checked before connecting and catalog listing. */
  async ready() {
    const entries = await this.connection.ready();
    const selected = entries.filter((entry) =>
      this.options.allowedTools.includes(entry.identity.original_name),
    );
    if (selected.length !== this.options.allowedTools.length)
      throw new Error('Device MCP selected catalog unavailable');
    return selected;
  }
  close() {
    return this.connection.close();
  }
  isLive() {
    return this.connection.isLive();
  }

  async call(
    raw: DeviceMcpBinding,
    args: Record<string, unknown>,
    signal: AbortSignal,
    revalidate: () => Promise<void>,
    // Trusted device transport must authenticate the Authority and verify its
    // source_digest against the bytes it uploaded before returning a receipt.
    uploadImage?: (bytes: Buffer) => Promise<{
      digest: string;
      size: number;
      mime: 'image/png';
      expires_at: number;
    }>,
  ): Promise<DeviceMcpResult> {
    const binding = DeviceMcpBindingSchema.parse(raw);
    const authorize = () => {
      if (
        binding.node_id !== this.nodeId ||
        binding.owner_id !== this.ownerId ||
        binding.server_id !== this.serverId ||
        binding.manifest_hash !== this.manifestHash ||
        binding.configuration_digest !== this.configurationDigest ||
        !this.options.allowedTools.includes(binding.tool_name) ||
        binding.expires_at <= Date.now() ||
        signal.aborted
      )
        throw new Error('Device MCP authority unavailable');
      this.options.authorizeCall(binding);
    };
    return executeDeviceMcpOnce(
      this.options.database,
      binding,
      args,
      authorize,
      async () => {
        try {
          const catalog = await this.connection.ready();
          const tool = catalog.find(
            (entry) => entry.identity.original_name === binding.tool_name,
          );
          if (
            tool?.definition.annotations?.['opendot.requiresImageGrant'] ===
              true &&
            !uploadImage
          )
            return { outcome: 'not_sent', error_code: 'UNAVAILABLE' };
          let attachment:
            | {
                digest: string;
                size: number;
                mime: 'image/png';
                expires_at: number;
              }
            | undefined;
          const result = await this.connection.dispatch({
            intent: binding.intent,
            arguments: args,
            signal,
            beforeDispatch: revalidate,
            recheck: authorize,
            // The device receipt already contains durable dispatch intent.
            markDispatched: () => {},
            prepareResult: async (rawResult) => {
              const images = rawResult.content.filter(
                (block) => block.type === 'image',
              );
              if (!images.length) return rawResult;
              if (
                !uploadImage ||
                images.length !== 1 ||
                rawResult.content.some(
                  (block) => block.type !== 'text' && block.type !== 'image',
                )
              )
                throw new Error('Image result unavailable');
              const image = images[0]!;
              if (
                image.type !== 'image' ||
                !['image/png', 'image/jpeg'].includes(image.mimeType) ||
                image.data.length > 5592408 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                  image.data,
                )
              )
                throw new Error('Image result invalid');
              const decoded = Buffer.from(image.data, 'base64');
              if (
                !decoded.length ||
                decoded.length > 4194304 ||
                decoded.toString('base64') !== image.data
              )
                throw new Error('Image result exceeds budget');
              const normalized = normalizeScreenshotImage(
                decoded,
                image.mimeType,
              );
              await revalidate();
              authorize();
              attachment = await uploadImage(normalized.bytes);
              await revalidate();
              authorize();
              // The Authority independently re-encodes the PNG to strip metadata.
              // Its canonical bytes may differ from the uploaded representation;
              // the transport validates the uploaded source digest separately.
              if (
                !/^[0-9a-f]{64}$/.test(attachment.digest) ||
                attachment.size < 1 ||
                attachment.size > 4194304 ||
                attachment.mime !== 'image/png'
              )
                throw new Error('Image attachment receipt conflict');
              return {
                ...rawResult,
                content: rawResult.content.filter(
                  (block) => block.type === 'text',
                ),
              };
            },
          });
          // Binary content requires the separately authorized attachment channel.
          if (result.content.some((block) => block.type !== 'text'))
            return { outcome: 'uncertain', error_code: 'INVALID_RESULT' };
          // Do not smuggle image or other binary payloads through arbitrary
          // structured content or metadata in the text-only device protocol.
          const content = mcpCanonicalJson({ content: result.content });
          if (Buffer.byteLength(content) > 65536)
            return { outcome: 'uncertain', error_code: 'INVALID_RESULT' };
          return {
            outcome: 'completed',
            content,
            content_digest: deviceTextDigest(content),
            ...(attachment ? { attachment } : {}),
          };
        } catch (error) {
          return error instanceof McpDeliveryError &&
            error.delivery === 'not_sent'
            ? { outcome: 'not_sent', error_code: 'UNAVAILABLE' }
            : { outcome: 'uncertain', error_code: 'SERVER_ERROR' };
        }
      },
    );
  }
}
