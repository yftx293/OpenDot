import {
  inspectKimiWebBridge,
  inspectKimiComputerUse,
  kimiHeartbeatSupportsComputerUse,
  kimiReadinessForHeartbeat,
  type KimiReadiness,
  type KimiComputerUseReadiness,
} from './personal-agent/kimi-readiness.js';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { z } from 'zod';
import { loadDeviceMcpConfiguration } from './personal-agent/device-mcp-configuration.js';
import {
  LocalDeviceMcpServer,
  deviceMcpDeclarationDigest,
} from './personal-agent/device-mcp-local.js';
import { mcpCanonicalJson, mcpDigest } from './mcp-contract.js';
import { withDeviceMcpStartupCandidate } from './personal-agent/device-mcp-startup-owner.js';
import {
  createDeviceReader,
  openDeviceState,
  prepareDeviceIdentity,
  cachedDeviceRead,
  executeDeviceMcpStartupOnce,
} from './personal-agent/device-local.js';
import {
  DeviceHashSchema,
  DevicePathSchema,
  DeviceMcpBindingSchema,
  DeviceMcpStartupBindingSchema,
  type DeviceMcpStartupBinding,
  deviceDigest,
  deviceTextDigest,
} from './personal-agent/device-protocol.js';

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      gateway: { type: 'string' },
      root: { type: 'string' },
      state: { type: 'string' },
      'allow-file': { type: 'string', multiple: true },
      'mcp-config': { type: 'string' },
      'kimi-status': { type: 'boolean' },
      pair: { type: 'boolean' },
    },
  });
  if (
    !values.gateway ||
    !values.state ||
    (values['mcp-config']
      ? !!values.root || !!values['allow-file']?.length
      : !values.root || !values['allow-file']?.length)
  )
    throw new Error(
      'Required: --gateway URL --state PRIVATE_DIR/node.sqlite and either --root DIR --allow-file RELATIVE_FILE or --mcp-config PRIVATE_FILE [--pair (code via stdin)]',
    );
  const url = new URL(values.gateway);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error(
      'Gateway requires HTTPS (HTTP only on literal loopback) without credentials, query or fragment',
    );
  const base = url.href.replace(/\/$/, '');
  const state = openDeviceState(values.state);
  const mcp = values['mcp-config']
    ? loadDeviceMcpConfiguration(values['mcp-config'])
    : undefined;
  const reader =
    !mcp && values.root && values['allow-file']
      ? createDeviceReader(values.root, values['allow-file'], state.filename)
      : undefined;
  const manifest = mcp?.manifest ?? reader?.manifest;
  if (!manifest) throw new Error('Device declaration unavailable');
  let pair: string | undefined;
  if (values.pair) {
    const input = createInterface({ input: process.stdin, terminal: false });
    pair = (await input[Symbol.asyncIterator]().next()).value?.trim();
    input.close();
  }
  const identity = prepareDeviceIdentity(state.database, base, manifest, pair);
  const dispatcher = new EnvHttpProxyAgent();
  let stopped = false;
  process.once('SIGINT', () => {
    stopped = true;
  });
  process.once('SIGTERM', () => {
    stopped = true;
  });
  const request = async (
    endpoint: string,
    body?: unknown,
    authenticated = true,
  ) => {
    const response = await fetch(`${base}/api/device-nodes/${endpoint}`, {
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${identity.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ([401, 403, 404].includes(response.status)) {
      stopped = true;
      throw new Error(
        'Node authorization closed; review pairing and revocation',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gateway retryable status ${response.status}`);
    }
    // Server responses are bounded independently of the read result payload.
    let data = '';
    let bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > 262144) throw new Error('Gateway response too large');
      data += decoder.decode(chunk, { stream: true });
    }
    data += decoder.decode();
    return JSON.parse(data) as unknown;
  };
  const fileCommandSchema = z.object({
    id: z.uuid(),
    lease_id: z.uuid(),
    params_digest: DeviceHashSchema,
    path: DevicePathSchema,
    manifest_hash: DeviceHashSchema,
    capability: z.literal('files.read'),
  });
  const common = {
    id: z.uuid(),
    lease_id: z.uuid(),
    params_digest: DeviceHashSchema,
    manifest_hash: DeviceHashSchema,
  };
  const commandSchema = z.union([
    fileCommandSchema,
    z
      .object({
        ...common,
        capability: z.literal('mcp.start'),
        binding: DeviceMcpStartupBindingSchema,
      })
      .strict(),
    z
      .object({
        ...common,
        capability: z.literal('mcp'),
        binding: DeviceMcpBindingSchema,
        arguments: z.record(z.string(), z.unknown()),
        allow_images: z.boolean().default(false),
      })
      .strict(),
  ]);
  const servers = new Map<
    string,
    {
      server: LocalDeviceMcpServer;
      verifiedUntil: number;
      binding: DeviceMcpStartupBinding;
    }
  >();
  let attempts = 0;
  let kimiReadiness: KimiReadiness | undefined;
  let kimiComputerUse: KimiComputerUseReadiness | undefined;
  let hostAcceptsKimiComputerUse = false;
  let nextKimiCheck = 0;
  try {
    while (!stopped) {
      try {
        if (!identity.node_id) {
          const response = z
            .object({ device: z.object({ id: z.uuid() }) })
            .parse(
              await request(
                'join',
                {
                  pair_code: identity.pair_code,
                  claim_request_id: identity.claim_id,
                  token_hash: deviceTextDigest(identity.token),
                  manifest,
                },
                false,
              ),
            );
          state.database
            .prepare('UPDATE identity SET node_id=?,pair_code=NULL WHERE id=1')
            .run(response.device.id);
          identity.node_id = response.device.id;
          identity.pair_code = null;
          console.log(
            `Paired node ${identity.node_id}; awaiting separate identity and capability approval`,
          );
        }
        if (values['kimi-status'] && Date.now() >= nextKimiCheck) {
          kimiReadiness = await inspectKimiWebBridge();
          kimiComputerUse = hostAcceptsKimiComputerUse
            ? await inspectKimiComputerUse()
            : undefined;
          nextKimiCheck = Date.now() + 60_000;
        }
        let heartbeat: unknown;
        try {
          heartbeat = await request('transport/heartbeat', {
            manifest_hash: deviceDigest(manifest),
            ready: true,
            ...(kimiReadiness ? {
              kimi_readiness: kimiReadinessForHeartbeat(kimiReadiness, kimiComputerUse, hostAcceptsKimiComputerUse),
            } : {}),
          });
        } catch (error) {
          // A rolled-back older host can reject the optional nested field.
          // Retry the next heartbeat in legacy form before negotiating again.
          hostAcceptsKimiComputerUse = false;
          throw error;
        }
        const accepted = kimiHeartbeatSupportsComputerUse(heartbeat);
        if (accepted && !hostAcceptsKimiComputerUse) nextKimiCheck = 0;
        hostAcceptsKimiComputerUse = accepted;
        if (servers.size) {
          const live = z.object({ allowed: z.array(z.uuid()).max(50) }).parse(
            await request('transport/mcp-connections', {
              bindings: [...servers.values()].map((entry) => entry.binding),
            }),
          );
          for (const [id, entry] of servers)
            if (!live.allowed.includes(id)) {
              servers.delete(id);
              await entry.server.close();
            }
        }
        const response = z
          .object({ command: commandSchema.nullable() })
          .parse(await request('transport/commands'));
        if (response.command) {
          const command = response.command;
          if (command.manifest_hash !== deviceDigest(manifest))
            throw new Error('Node manifest conflict');
          let result: unknown;
          if (command.capability === 'files.read') {
            if (!reader) throw new Error('File capability unavailable');
            result = cachedDeviceRead(state.database, command, reader.read);
          } else {
            if (!mcp || !identity.node_id)
              throw new Error('Device MCP unavailable');
            const check = async () => {
              await request('transport/check', {
                command_id: command.id,
                lease_id: command.lease_id,
                params_digest: command.params_digest,
              });
            };
            await check();
            if (command.capability === 'mcp.start') {
              const binding = command.binding;
              const local = mcp.servers.find(
                (s) => s.server_id === binding.server_id,
              );
              if (
                !local ||
                binding.owner_id !== mcp.owner_id ||
                binding.node_id !== identity.node_id ||
                binding.manifest_hash !== deviceDigest(manifest) ||
                binding.id !== command.id ||
                binding.declaration_digest !==
                  deviceMcpDeclarationDigest(local.definition, local.cwd) ||
                local.definition.pi.location.kind !== 'device'
              )
                throw new Error('Device MCP startup mismatch');
              const definition = {
                ...local.definition,
                pi: {
                  ...local.definition.pi,
                  location: {
                    kind: 'device' as const,
                    node_id: identity.node_id,
                  },
                },
              };
              if (mcpDigest(definition) !== binding.configuration_digest)
                throw new Error('Device MCP configuration mismatch');
              let leaseUntil = Date.now() + 5000;
              let entry: {
                server: LocalDeviceMcpServer;
                verifiedUntil: number;
                binding: DeviceMcpStartupBinding;
              };
              entry = {
                server: new LocalDeviceMcpServer({
                  database: state.database,
                  nodeId: identity.node_id,
                  ownerId: mcp.owner_id,
                  serverId: binding.server_id,
                  manifest,
                  definition,
                  cwd: local.cwd,
                  allowedTools: binding.tools,
                  authorizeStartup: () => {
                    if (Date.now() >= leaseUntil)
                      throw new Error('Device startup check expired');
                  },
                  authorizeCall: () => {
                    if (Date.now() >= entry.verifiedUntil)
                      throw new Error('Device call check expired');
                  },
                }),
                verifiedUntil: 0,
                binding,
              };
              result = await withDeviceMcpStartupCandidate(
                entry.server,
                () => servers.get(binding.consent_id)?.server === entry.server,
                () =>
                  executeDeviceMcpStartupOnce(
                    state.database,
                    binding,
                    () => {
                      if (Date.now() >= leaseUntil)
                        throw new Error('Device startup check expired');
                    },
                    () =>
                      servers.get(binding.consent_id)?.server.isLive() === true,
                    async () => {
                      if (servers.has(binding.consent_id))
                        throw new Error(
                          'Device MCP consent already has a live connection',
                        );
                      const entries = await entry.server.ready();
                      await check();
                      leaseUntil = Date.now() + 5000;
                      const catalog = mcpCanonicalJson(entries);
                      servers.set(binding.consent_id, entry);
                      return {
                        outcome: 'completed',
                        catalog,
                        catalog_digest: deviceTextDigest(catalog),
                      };
                    },
                  ),
              );
            } else {
              const entry = servers.get(command.binding.grant_id);
              if (!entry) throw new Error('Device MCP process unavailable');
              entry.verifiedUntil = Date.now() + 5000;
              result = await entry.server.call(
                command.binding,
                command.arguments,
                AbortSignal.timeout(25000),
                async () => {
                  await check();
                  entry.verifiedUntil = Date.now() + 5000;
                },
                command.allow_images
                  ? async (bytes) => {
                      await check();
                      const response = await fetch(
                        `${base}/api/device-nodes/transport/attachment`,
                        {
                          dispatcher,
                          redirect: 'error',
                          signal: AbortSignal.timeout(10000),
                          method: 'POST',
                          headers: {
                            Authorization: `Bearer ${identity.token}`,
                            'Content-Type': 'image/png',
                            'X-Device-Command': command.id,
                            'X-Device-Lease': command.lease_id,
                            'X-Device-Params-Digest': command.params_digest,
                            'X-Content-SHA256': createHash('sha256')
                              .update(bytes)
                              .digest('hex'),
                          },
                          body: bytes,
                        },
                      );
                      if (!response.ok) {
                        await response.body?.cancel();
                        throw new Error('Image upload unavailable');
                      }
                      const parts: Uint8Array[] = [];
                      let length = 0;
                      for await (const part of response.body ?? []) {
                        length += part.byteLength;
                        if (length > 8192)
                          throw new Error('Image receipt exceeds limit');
                        parts.push(part);
                      }
                      const receipt = z
                        .object({
                          source_digest: DeviceHashSchema,
                          attachment: z
                            .object({
                              digest: DeviceHashSchema,
                              size: z.number().int().positive().max(4194304),
                              mime: z.literal('image/png'),
                              expires_at: z.number().int().positive(),
                            })
                            .strict(),
                        })
                        .strict()
                        .parse(
                          JSON.parse(Buffer.concat(parts).toString('utf8')),
                        );
                      if (
                        receipt.source_digest !==
                        createHash('sha256').update(bytes).digest('hex')
                      )
                        throw new Error('Image upload source receipt conflict');
                      await check();
                      entry.verifiedUntil = Date.now() + 5000;
                      return receipt.attachment;
                    }
                  : undefined,
              );
            }
          }
          await request('transport/result', {
            command_id: command.id,
            lease_id: command.lease_id,
            params_digest: command.params_digest,
            result,
          });
          console.log(`Device receipt acknowledged ${command.id}`);
        }
        attempts = 0;
        await delay(1000);
      } catch {
        if (servers.size) {
          await Promise.allSettled(
            [...servers.values()].map((entry) => entry.server.close()),
          );
          servers.clear();
        }
        if (!stopped) {
          attempts++;
          if (attempts === 1 || attempts % 30 === 0)
            console.error(
              'Node transport unavailable; retaining original identity and read receipts',
            );
          await delay(Math.min(5000, 250 * 2 ** Math.min(attempts, 5)));
        }
      }
    }
  } finally {
    await Promise.allSettled(
      [...servers.values()].map((entry) => entry.server.close()),
    );
    if (identity.node_id) {
      try {
        await request('transport/heartbeat', {
          manifest_hash: deviceDigest(manifest),
          ready: false,
        });
      } catch {
        /* Already revoked or unavailable. */
      }
    }
    state.database.close();
    await dispatcher.close();
  }
  if (stopped) process.exitCode = 1;
}
main().catch(() => {
  console.error(
    'Device node could not start; verify arguments, private state permissions and pairing. Credentials and file contents are not logged.',
  );
  process.exitCode = 1;
});
