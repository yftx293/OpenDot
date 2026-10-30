import { createHash } from 'node:crypto';
import { z } from 'zod';
import { McpCallIntentSchema } from '../mcp-contract.js';

export const DEVICE_MEMO = 'miniclaw.device-command.v1';
export const deviceDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const deviceTextDigest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const DeviceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const DevicePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (value.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(value)) return false;
    return value
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
      );
  }, 'A declared relative file path is required');
const names = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const DeviceManifestSchema = z
  .object({
    version: z.literal(1),
    capability: z.literal('files.read'),
    root_label: names,
    root_fingerprint: DeviceHashSchema,
    paths: z
      .array(DevicePathSchema)
      .min(1)
      .max(50)
      .transform((values) => [...new Set(values)].sort()),
  })
  .strict();
export type DeviceManifest = z.infer<typeof DeviceManifestSchema>;
/** The device MCP channel has its own capability. A file-read manifest or
 * grant never authorizes an MCP process, catalog discovery, or tool call. */
export const DeviceMcpManifestSchema = z
  .object({
    version: z.literal(2),
    capability: z.literal('mcp'),
    servers: z
      .array(
        z
          .object({
            server_id: names,
            configuration_digest: DeviceHashSchema,
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .refine(
        (servers) =>
          new Set(servers.map((s) => s.server_id)).size === servers.length,
      ),
  })
  .strict();

export const DeviceAnyManifestSchema = z.union([
  DeviceManifestSchema,
  DeviceMcpManifestSchema,
]);
export type DeviceAnyManifest = z.infer<typeof DeviceAnyManifestSchema>;
export const DeviceTicketSchema = z.object({ name: names }).strict();
export const DeviceJoinSchema = z
  .object({
    pair_code: DeviceHashSchema,
    claim_request_id: z.uuid(),
    token_hash: DeviceHashSchema,
    manifest: DeviceAnyManifestSchema,
  })
  .strict();
export const DeviceGrantSchema = z
  .object({
    confirmed: z.literal(true),
    workspace_jid: z.string().startsWith('web:').max(256),
    capability: z.literal('files.read'),
    paths: z
      .array(DevicePathSchema)
      .min(1)
      .max(50)
      .transform((values) => [...new Set(values)].sort()),
    ttl_seconds: z.number().int().min(60).max(86400).default(3600),
    expected_revision: z.number().int().positive(),
    cloud_request_id: z.uuid().optional(),
  })
  .strict();
export const DeviceMcpGrantSchema = z
  .object({
    confirmed: z.literal(true),
    expected_revision: z.number().int().positive(),
    workspace_jid: z.string().startsWith('web:').max(256),
    session_id: z.uuid(),
    dot_id: z.uuid(),
    server_id: names,
    declaration_digest: DeviceHashSchema,
    tools: z
      .array(names)
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length),
    ttl_seconds: z.number().int().min(60).max(86400),
    allow_images: z.boolean().default(false),
  })
  .strict();
/** Startup and catalog discovery carry a session-consent identity, not a
 * fabricated ToolTask. The command is persisted before process creation. */
export const DeviceMcpStartupBindingSchema = z
  .object({
    version: z.literal(2),
    capability: z.literal('mcp.start'),
    id: z.uuid(),
    owner_id: names,
    workspace_jid: z.string().startsWith('web:').max(256),
    session_id: z.uuid(),
    dot_id: z.uuid(),
    node_id: z.uuid(),
    device_grant_id: z.uuid(),
    consent_id: z.uuid(),
    manifest_hash: DeviceHashSchema,
    server_id: names,
    configuration_digest: DeviceHashSchema,
    declaration_digest: DeviceHashSchema,
    tools: z
      .array(names)
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length),
    expires_at: z.number().int().positive(),
  })
  .strict();
export type DeviceMcpStartupBinding = z.infer<
  typeof DeviceMcpStartupBindingSchema
>;
export const DeviceMcpStartupResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('completed'),
      catalog: z.string().refine((v) => Buffer.byteLength(v) <= 262144),
      catalog_digest: DeviceHashSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('not_sent'),
      error_code: z.enum(['UNAUTHORIZED', 'EXPIRED', 'UNAVAILABLE']),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('uncertain'),
      error_code: z.enum([
        'CONNECTION_LOST',
        'SERVER_ERROR',
        'INVALID_RESULT',
        'INTERRUPTED',
      ]),
    })
    .strict(),
]);
export type DeviceMcpStartupResult = z.infer<
  typeof DeviceMcpStartupResultSchema
>;
export const DeviceBindingSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    owner_id: z.string().min(1).max(200),
    workspace_jid: z.string().startsWith('web:').max(256),
    session_id: z.uuid(),
    conversation_id: z.number().int().positive(),
    tool_task_id: z.number().int().positive(),
    generation_task_id: z.number().int().positive(),
    call_id: z.string().min(1).max(200),
    goal_run_id: z.string().nullable(),
    node_id: z.uuid(),
    grant_id: z.uuid(),
    manifest_hash: DeviceHashSchema,
    path: DevicePathSchema,
    cloud_scope: z
      .object({
        request_id: z.uuid(),
        goal_id: z.uuid(),
        handoff_id: z.uuid(),
        cloud_session_id: z.uuid(),
        operation_digest: DeviceHashSchema,
        deadline_at: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DeviceBinding = z.infer<typeof DeviceBindingSchema>;
export const DeviceReadResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      content: z.string().refine((value) => Buffer.byteLength(value) <= 65536),
      content_digest: DeviceHashSchema,
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
export type DeviceReadResult = z.infer<typeof DeviceReadResultSchema>;

/** The authority freezes these identities before dispatch. Arguments are
 * separately transported and checked against args_digest by the device. */
export const DeviceMcpBindingSchema = z
  .object({
    version: z.literal(2),
    capability: z.literal('mcp'),
    id: z.uuid(),
    owner_id: names,
    workspace_jid: z.string().startsWith('web:').max(256),
    session_id: z.uuid(),
    dot_id: names,
    node_id: z.uuid(),
    grant_id: z.uuid(),
    device_grant_id: z.uuid(),
    grant_revision: z.number().int().positive(),
    cancel_generation: z.number().int().nonnegative(),
    manifest_hash: DeviceHashSchema,
    server_id: names,
    configuration_digest: DeviceHashSchema,
    catalog_digest: DeviceHashSchema,
    schema_digest: DeviceHashSchema,
    tool_name: names,
    call_id: names,
    args_digest: DeviceHashSchema,
    expires_at: z.number().int().positive(),
    intent: McpCallIntentSchema,
  })
  .strict()
  .refine((value) => {
    const i = value.intent;
    return (
      i.call_id === value.call_id &&
      i.call_id === value.id &&
      i.owner_id === value.owner_id &&
      i.workspace_jid === value.workspace_jid &&
      i.session_id === value.session_id &&
      i.dot_id === value.dot_id &&
      i.location.kind === 'device' &&
      i.location.node_id === value.node_id &&
      i.grant_id === value.grant_id &&
      i.grant_revision === value.grant_revision &&
      i.cancel_generation === value.cancel_generation &&
      i.server_id === value.server_id &&
      i.server_config_digest === value.configuration_digest &&
      i.catalog_digest === value.catalog_digest &&
      i.schema_digest === value.schema_digest &&
      i.original_name === value.tool_name &&
      i.arguments_digest === value.args_digest &&
      i.expires_at === value.expires_at
    );
  }, 'Device command and MCP intent must match');
export type DeviceMcpBinding = z.infer<typeof DeviceMcpBindingSchema>;

/** A missing receipt after dispatch is uncertain; callers must not turn it
 * into an error receipt or issue a new identity for a possibly executed call. */
export const DeviceMcpResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('completed'),
      content: z.string().refine((value) => Buffer.byteLength(value) <= 65536),
      content_digest: DeviceHashSchema,
      attachment: z
        .object({
          digest: DeviceHashSchema,
          size: z.number().int().positive().max(4194304),
          mime: z.literal('image/png'),
          expires_at: z.number().int().positive(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('not_sent'),
      error_code: z.enum([
        'UNAUTHORIZED',
        'EXPIRED',
        'CATALOG_CHANGED',
        'INVALID_ARGUMENTS',
        'UNAVAILABLE',
      ]),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('uncertain'),
      error_code: z.enum([
        'CONNECTION_LOST',
        'SERVER_ERROR',
        'INVALID_RESULT',
        'INTERRUPTED',
      ]),
    })
    .strict(),
]);
export type DeviceMcpResult = z.infer<typeof DeviceMcpResultSchema>;
