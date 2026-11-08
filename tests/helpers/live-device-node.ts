import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { waitFor } from './bot-handoff-http-fixture.js';

type DeviceFixture = {
  root: string;
  origin: string;
  credentials: { username: string };
  call: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  json: <T>(response: unknown) => Promise<T>;
};

export type PairedDeviceServer = {
  node: ChildProcess;
  nodeLog: { text: string };
  device: any;
  ticket: { pair_code: string };
};

export function countDeviceCommands(root: string): number {
  const read = new Database(path.join(root, 'data/db/messages.db'), {
    readonly: true,
  });
  try {
    return (
      read.prepare('SELECT count(*) AS n FROM device_commands').get() as {
        n: number;
      }
    ).n;
  } finally {
    read.close();
  }
}

function fixtureOwnerId(root: string, username: string): string {
  const db = new Database(path.join(root, 'data/db/messages.db'), {
    readonly: true,
  });
  try {
    return (
      db.prepare('SELECT id FROM users WHERE username=?').get(username) as {
        id: string;
      }
    ).id;
  } finally {
    db.close();
  }
}

/**
 * Registers one MCP server on a fresh host and pairs an approved device node.
 * Grant, consent, approval, and revocation checks stay in the caller.
 */
export async function pairApprovedDeviceServer(
  f: DeviceFixture,
  input: {
    id: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    policy: object;
  },
): Promise<PairedDeviceServer> {
  const owner = fixtureOwnerId(f.root, f.credentials.username);
  const created = await f.json<{ server: any }>(
    await f.call('/api/mcp-servers', 'POST', {
      id: input.id,
      command: input.command,
      args: input.args,
      env: input.env,
      pi: input.policy,
    }),
  );
  const server = created.server;
  const config = path.join(f.root, 'device-mcp.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      owner_id: owner,
      servers: [
        {
          server_id: input.id,
          cwd: fs.realpathSync(f.root),
          definition: {
            enabled: true,
            addedAt: server.addedAt,
            command: server.command,
            args: server.args,
            env: input.env,
            pi: input.policy,
          },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const { ticket } = await f.json<{ ticket: { pair_code: string } }>(
    await f.call('/api/device-nodes/pair-tickets', 'POST', {
      name: 'Fixture node',
    }),
  );
  const nodeLog = { text: '' };
  const node = spawn(
    process.execPath,
    [
      '--import',
      path.resolve('node_modules/tsx/dist/loader.mjs'),
      path.resolve('scripts/device-node.ts'),
      '--gateway',
      f.origin,
      '--state',
      path.join(f.root, 'node-private/node.sqlite'),
      '--mcp-config',
      config,
      '--pair',
    ],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: path.join(f.root, 'home') },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  node.stdout?.on('data', (chunk) => {
    nodeLog.text += String(chunk);
  });
  node.stderr?.on('data', (chunk) => {
    nodeLog.text += String(chunk);
  });
  try {
    node.stdin?.end(`${ticket.pair_code}\n`);
    let device: any;
    await waitFor(async () => {
      device = (await f.json<any>(await f.call('/api/device-nodes')))
        .devices[0];
      return !!device;
    });
    device = (
      await f.json<any>(
        await f.call(`/api/device-nodes/${device.id}/approve`, 'POST', {
          confirmed: true,
          expected_revision: device.revision,
        }),
      )
    ).device;
    await f.json(
      await f.call(`/api/mcp-servers/${input.id}`, 'PATCH', {
        pi: {
          ...input.policy,
          location: { kind: 'device', node_id: device.id },
        },
      }),
    );
    return { node, nodeLog, device, ticket };
  } catch (error) {
    if (node.exitCode === null && !node.signalCode) {
      node.kill('SIGINT');
      await once(node, 'exit').catch(() => {});
    }
    throw error;
  }
}

/** Starts one local computer server through the setup API and waits until it is online. */
export async function enableLocalComputer(
  f: DeviceFixture,
  input: { serverId: string; ticketName: string },
) {
  const paths = await f.json<{
    command: string;
    loader?: string;
    computer: string;
  }>(await f.call('/api/local-device-setup'));
  const policy = {
    version: 1,
    enabled: true,
    location: { kind: 'device', node_id: randomUUID() },
    tools: [
      'list_windows',
      'open_application',
      'observe_window',
      'act_on_window',
    ],
  };
  await f.json(
    await f.call('/api/mcp-servers', 'POST', {
      id: input.serverId,
      command: paths.command,
      args: [
        ...(paths.loader ? ['--import', paths.loader] : []),
        paths.computer,
      ],
      env: {},
      pi: policy,
    }),
  );
  const { ticket } = await f.json<{ ticket: { pair_code: string } }>(
    await f.call('/api/device-nodes/pair-tickets', 'POST', {
      name: input.ticketName,
    }),
  );
  await f.json(
    await f.call('/api/local-device-setup/start', 'POST', {
      serverId: input.serverId,
      pairCode: ticket.pair_code,
    }),
  );
  let device: { id: string } | undefined;
  await waitFor(async () => {
    device = (
      await f.json<{ devices: any[] }>(await f.call('/api/device-nodes'))
    ).devices.find((entry) =>
      entry.manifest?.servers?.some(
        (server: { server_id: string }) => server.server_id === input.serverId,
      ),
    );
    return !!device;
  });
  if (!device) throw new Error('Local computer device unavailable');
  const nodeId = device.id;
  await f.json(
    await f.call(`/api/mcp-servers/${input.serverId}`, 'PATCH', {
      pi: { ...policy, location: { kind: 'device', node_id: nodeId } },
    }),
  );
  await f.json(
    await f.call('/api/local-device-setup/computer', 'POST', {
      serverId: input.serverId,
      nodeId,
    }),
  );
  await waitFor(async () =>
    (
      await f.json<{ devices: { id: string; online?: boolean }[] }>(
        await f.call('/api/device-nodes'),
      )
    ).devices.some((entry) => entry.id === nodeId && entry.online),
  );
  return device;
}
