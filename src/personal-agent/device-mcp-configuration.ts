import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PiMcpPolicySchema } from '../mcp-contract.js';
import type {
  StoredMcpServerDefinition,
  StoredMcpServerSecrets,
} from '../mcp-utils.js';
import { deviceMcpDeclarationDigest } from './device-mcp-local.js';
import { DeviceMcpManifestSchema } from './device-protocol.js';

const definition = z
  .object({
    enabled: z.literal(true),
    addedAt: z.string().min(1).max(128),
    command: z.string().min(1).max(2048).optional(),
    args: z.array(z.string().max(8192)).max(100).optional(),
    type: z.literal('http').optional(),
    url: z.string().url().max(2048).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    description: z.string().max(4096).optional(),
    importedFromHost: z.boolean().optional(),
    syncedFromHost: z.boolean().optional(),
    memberAccess: z.enum(['admin_only', 'shared']).optional(),
    pi: PiMcpPolicySchema,
  })
  .strict()
  .refine(
    (value) =>
      value.pi.enabled &&
      value.pi.location.kind === 'device' &&
      value.pi.tools.length > 0,
  )
  .refine((value) =>
    value.type === 'http'
      ? !!value.url && !value.command
      : !!value.command && path.isAbsolute(value.command) && !value.url,
  );
const configSchema = z
  .object({
    owner_id: z.string().min(1).max(100),
    servers: z
      .array(
        z
          .object({
            server_id: z.string().min(1).max(100),
            cwd: z.string().refine(path.isAbsolute),
            definition,
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.servers.map((server) => server.server_id)).size ===
      value.servers.length,
  );

/** Read a private, immutable-at-open local declaration. It contains credentials;
 * it is never sent to the Authority, printed, or inherited from HOME. */
export function loadDeviceMcpConfiguration(filename: string) {
  const absolute = path.resolve(filename);
  if (fs.realpathSync(absolute) !== absolute)
    throw new Error('Device MCP configuration requires a real path');
  const fd = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 262144
    )
      throw new Error(
        'Device MCP configuration must be a private regular file',
      );
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size)
      throw new Error('Device MCP configuration changed while reading');
    const parsed = configSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ),
    );
    const after = fs.fstatSync(fd);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('Device MCP configuration changed while reading');
    for (const server of parsed.servers) {
      if (
        fs.realpathSync(server.cwd) !== server.cwd ||
        !fs.statSync(server.cwd).isDirectory()
      )
        throw new Error(
          'Device MCP working directory must be a real directory',
        );
    }
    const manifest = DeviceMcpManifestSchema.parse({
      version: 2,
      capability: 'mcp',
      servers: parsed.servers.map((server) => ({
        server_id: server.server_id,
        configuration_digest: deviceMcpDeclarationDigest(
          server.definition as StoredMcpServerDefinition &
            StoredMcpServerSecrets,
          server.cwd,
        ),
      })),
    });
    return { ...parsed, manifest };
  } finally {
    fs.closeSync(fd);
  }
}
