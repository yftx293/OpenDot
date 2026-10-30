import { createHash } from 'node:crypto';
import { z } from 'zod';

const name = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Opt-in metadata on the existing managed server definition. No legacy default. */
export const PiMcpPolicySchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    location: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('host') }).strict(),
      z.object({ kind: z.literal('device'), node_id: z.uuid() }).strict(),
    ]),
    tools: z
      .array(name)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type PiMcpPolicy = z.infer<typeof PiMcpPolicySchema>;

/** Stable JSON for identities, never a log representation of call arguments. */
export function mcpCanonicalJson(value: unknown): string {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('MCP JSON depth exceeded');
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value))
      return value.map((child) => visit(child, depth + 1));
    if (
      value &&
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    ) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, visit(child, depth + 1)]),
      );
    }
    throw new Error('MCP requires JSON values');
  };
  const result = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(result) > 262144)
    throw new Error('MCP JSON size exceeded');
  return result;
}
export const mcpDigest = (value: unknown) =>
  createHash('sha256').update(mcpCanonicalJson(value)).digest('hex');

export const McpCatalogToolSchema = z
  .object({
    name,
    title: z.string().max(1024).optional(),
    description: z.string().max(16384).optional(),
    inputSchema: z
      .record(z.string(), z.unknown())
      .refine((value) => value.type === 'object'),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    // Unknown metadata participates in the frozen catalog digest too.
  })
  .passthrough();
export type McpCatalogTool = z.infer<typeof McpCatalogToolSchema>;

export type McpToolIdentity = {
  version: 1;
  owner_id: string;
  server_id: string;
  original_name: string;
  registered_name: string;
  catalog_digest: string;
  schema_digest: string;
  server_config_digest: string;
  location: PiMcpPolicy['location'];
};
export type McpCatalogEntry = {
  identity: McpToolIdentity;
  definition: McpCatalogTool;
};

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

export function registeredName(server: string, tool: string): string {
  const original = `mcp__${server}__${tool}`;
  const normalized = original.replace(/[^A-Za-z0-9_-]/g, '_');
  return normalized.length <= 64
    ? normalized
    : `${normalized.slice(0, 47)}_${mcpDigest(original).slice(0, 16)}`;
}

/** Construct only explicitly selected tools; no normalization collision or implicit wildcard. */
export function buildMcpCatalog(input: {
  ownerId: string;
  serverId: string;
  serverConfigDigest: string;
  location: PiMcpPolicy['location'];
  listed: unknown;
  selected: readonly string[];
}): McpCatalogEntry[] {
  name.parse(input.ownerId);
  name.parse(input.serverId);
  hash.parse(input.serverConfigDigest);
  const location = PiMcpPolicySchema.shape.location.parse(input.location);
  const tools = z.array(McpCatalogToolSchema).max(1000).parse(input.listed);
  const byName = new Map<string, McpCatalogTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error('Duplicate MCP tool name');
    byName.set(tool.name, tool);
  }
  const catalogDigest = mcpDigest(
    [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
  const selected = z.array(name).max(100).parse(input.selected);
  if (new Set(selected).size !== selected.length)
    throw new Error('Duplicate MCP tool selection');
  const entries = selected.map((toolName): McpCatalogEntry => {
    const definition = byName.get(toolName);
    if (!definition) throw new Error('Selected MCP tool absent from catalog');
    if (registeredName(input.serverId, toolName).startsWith('mcp__miniclaw__'))
      throw new Error(
        'External MCP cannot use the reserved Miniclaw namespace',
      );
    return {
      definition,
      identity: {
        version: 1,
        owner_id: input.ownerId,
        server_id: input.serverId,
        original_name: toolName,
        registered_name: registeredName(input.serverId, toolName),
        catalog_digest: catalogDigest,
        server_config_digest: input.serverConfigDigest,
        schema_digest: mcpDigest({
          input: definition.inputSchema,
          output: definition.outputSchema ?? null,
        }),
        location,
      },
    };
  });
  indexMcpCatalog(entries);
  return entries.map(freezeJson);
}

/** Resolves historical IDs to the exact registered name, including across servers. */
export function indexMcpCatalog(
  entries: readonly McpCatalogEntry[],
): ReadonlyMap<string, McpCatalogEntry> {
  const index = new Map<string, McpCatalogEntry>();
  for (const entry of entries) {
    const id = entry.identity;
    for (const alias of new Set([
      id.registered_name,
      `mcp__${id.server_id}__${id.original_name}`,
    ])) {
      if (index.has(alias))
        throw new Error('MCP registered tool name collision');
      index.set(alias, entry);
    }
  }
  return index;
}

/** Profile catalog ∩ immutable session grant. miniclaw wildcard grants no external tools. */
export function selectGrantedMcpTools(
  entries: readonly McpCatalogEntry[],
  granted: readonly string[],
): McpCatalogEntry[] {
  const index = indexMcpCatalog(entries);
  const result = new Set<McpCatalogEntry>();
  for (const tool of granted) {
    if (tool === 'mcp__miniclaw__*') continue;
    const entry = index.get(tool);
    if (entry) result.add(entry);
    else if (tool.startsWith('mcp__')) throw new Error('Unknown MCP grant');
  }
  return [...result];
}

const sourceInput = z
  .object({
    submission_id: z.number().int().positive(),
    request_id: name,
    entry_id: z.number().int().positive(),
  })
  .strict();
export const McpMemberSourceSchema = z
  .object({
    lease_id: z.uuid(),
    run_id: z.uuid(),
    grant_id: z.uuid(),
    cancel_epoch: z.number().int().nonnegative(),
    control_epoch: z.number().int().nonnegative(),
  })
  .strict();
export const McpCallSourceSchema = z.discriminatedUnion('runtime', [
  z
    .object({
      runtime: z.literal('pi-durable'),
      conversation_id: z.number().int().positive(),
      tool_task_id: z.number().int().positive(),
      generation_task_id: z.number().int().positive(),
      ancestor_task_ids: z
        .array(z.number().int().positive())
        .min(2)
        .max(32)
        .refine((ids) => new Set(ids).size === ids.length),
      call_id: name,
      inputs: z.array(sourceInput).min(1).max(64),
      member: McpMemberSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      runtime: z.literal('pi-coding-agent'),
      conversation_id: name,
      business_turn_id: name,
      tool_call_id: name,
    })
    .strict(),
]);
export const McpCallIntentSchema = z
  .object({
    version: z.literal(1),
    operation: z.literal('mcp.call'),
    call_id: z.uuid(),
    owner_id: name,
    dot_id: z.uuid(),
    workspace_jid: z.string().startsWith('web:').max(256),
    session_id: z.uuid(),
    server_id: name,
    original_name: name,
    registered_name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    catalog_digest: hash,
    schema_digest: hash,
    server_config_digest: hash,
    arguments_digest: hash,
    location: PiMcpPolicySchema.shape.location,
    source: McpCallSourceSchema,
    grant_id: z.uuid(),
    grant_revision: z.number().int().positive(),
    cancel_generation: z.number().int().nonnegative(),
    expires_at: z.number().int().positive(),
  })
  .strict();
export type McpCallIntent = z.infer<typeof McpCallIntentSchema>;

export const MCP_CALL_MEMO = 'miniclaw.mcp.call.v1';
export const MCP_GENERATION_GRANTS_MEMO = 'miniclaw.mcp.generation-grants.v1';
/** Frozen before the generation's first provider request, never borrowed from a later Run. */
export const McpGenerationGrantSchema = McpCallIntentSchema.pick({
  version: true,
  owner_id: true,
  dot_id: true,
  workspace_jid: true,
  session_id: true,
  server_id: true,
  original_name: true,
  registered_name: true,
  catalog_digest: true,
  schema_digest: true,
  server_config_digest: true,
  location: true,
  grant_id: true,
  grant_revision: true,
  cancel_generation: true,
  expires_at: true,
})
  .extend({ member: McpMemberSourceSchema.optional() })
  .strict();
export const McpGenerationGrantsSchema = z
  .array(McpGenerationGrantSchema)
  .max(100)
  .refine(
    (rows) =>
      new Set(rows.map((row) => row.registered_name)).size === rows.length,
  );
export type McpGenerationGrant = z.infer<typeof McpGenerationGrantSchema>;
