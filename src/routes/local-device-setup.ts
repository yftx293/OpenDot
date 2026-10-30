import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { connectionFromHono, isEligibleDemoConnection } from '../demo-open.js';
import { readStoredUserMcpServers } from '../mcp-utils.js';
import { deviceNodesEnabled } from '../personal-agent/device-node-settings.js';
import { DATA_DIR, WEB_PORT } from '../config.js';
import {
  approvePersonalDevice,
  listPersonalDevices,
  revokePersonalDevice,
} from '../personal-agent/device-store.js';
import {
  clearComputerCapability,
  readComputerCapability,
  saveComputerCapability,
} from '../personal-agent/computer-capability-settings.js';

const routes = new Hono<{ Variables: Variables }>();
const execute = promisify(execFile);
const starts = new Map<
  string,
  {
    ownerId: string;
    pairDigest: string;
    state: 'starting' | 'exited';
    code?: number | null;
    child: ChildProcess;
  }
>();
routes.use('*', authMiddleware);
routes.use(
  '*',
  bodyLimit({
    maxSize: 8192,
    onError: (c) => c.json({ error: 'Request too large' }, 413),
  }),
);
routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (
    c.get('user').role !== 'admin' ||
    !isEligibleDemoConnection(connectionFromHono(c))
  )
    return c.json({ error: 'Local administrator access required' }, 403);
  const origin = c.req.header('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      )
        return c.json({ error: 'Local origin required' }, 403);
    } catch {
      return c.json({ error: 'Invalid origin' }, 403);
    }
  }
  await next();
});

function localPaths() {
  const root = fs.realpathSync(process.cwd());
  const builtNode = path.join(root, 'dist/device-node.js');
  const builtDesktop = path.join(root, 'dist/personal-agent/kimi-cu-mcp.js');
  const builtComputer = path.join(
    root,
    'dist/personal-agent/kimi-cu-agent-mcp.js',
  );
  const builtBrowser = path.join(
    root,
    'dist/personal-agent/kimi-webbridge-read-mcp.js',
  );
  if (
    [builtNode, builtDesktop, builtComputer, builtBrowser].every((file) =>
      fs.existsSync(file),
    )
  )
    return {
      root,
      loader: null,
      nodeScript: builtNode,
      desktop: builtDesktop,
      computer: builtComputer,
      browser: builtBrowser,
      command: process.execPath,
    };
  const loader = path.join(root, 'node_modules/tsx/dist/loader.mjs');
  const nodeScript = path.join(root, 'src/device-node.ts');
  const desktop = path.join(root, 'src/personal-agent/kimi-cu-mcp.ts');
  const computer = path.join(root, 'src/personal-agent/kimi-cu-agent-mcp.ts');
  const browser = path.join(
    root,
    'src/personal-agent/kimi-webbridge-read-mcp.ts',
  );
  if (
    ![loader, nodeScript, desktop, computer, browser].every((file) =>
      fs.existsSync(file),
    )
  )
    throw new Error('Local device runtime unavailable');
  return {
    root,
    loader,
    nodeScript,
    desktop,
    computer,
    browser,
    command: process.execPath,
  };
}

routes.get('/', (c) => {
  try {
    const p = localPaths();
    return c.json({
      available: process.platform === 'darwin',
      kimiInstalled: process.platform === 'darwin' && fs.existsSync('/Applications/KimiCU.app/Contents/MacOS/kimi-cu'),
      command: p.command,
      loader: p.loader,
      desktop: p.desktop,
      computer: p.computer,
      browser: p.browser,
    });
  } catch {
    return c.json({ available: false });
  }
});

routes.get('/windows', async (c) => {
  if (process.platform !== 'darwin')
    return c.json({ error: 'macOS required' }, 409);
  try {
    const script = path.join(
      fs.realpathSync(process.cwd()),
      'scripts/list-kimicu-windows.swift',
    );
    const result = await execute('/usr/bin/swift', [script], {
      timeout: 15000,
      maxBuffer: 128 * 1024,
    });
    const windows = z
      .array(
        z.strictObject({
          appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
          pid: z.number().int().positive(),
          windowId: z.number().int().positive(),
          appName: z.string().max(200),
          title: z.string().max(200),
        }),
      )
      .max(150)
      .parse(JSON.parse(result.stdout));
    return c.json({ windows });
  } catch {
    return c.json({ error: 'Unable to list local windows' }, 503);
  }
});

// Only fixed macOS settings panes can be opened; no caller-provided URL is used.
routes.post('/permissions', async (c) => {
  const input = z
    .strictObject({ permission: z.enum(['accessibility', 'screen-recording']) })
    .safeParse(await c.req.json().catch(() => null));
  if (process.platform !== 'darwin' || !input.success)
    return c.json({ error: 'Permission settings unavailable' }, 400);
  const pane =
    input.data.permission === 'accessibility'
      ? 'Privacy_Accessibility'
      : 'Privacy_ScreenCapture';
  try {
    await execute(
      '/usr/bin/open',
      [`x-apple.systempreferences:com.apple.preference.security?${pane}`],
      { timeout: 10000 },
    );
    return c.json({ opened: true });
  } catch {
    return c.json({ error: 'Unable to open macOS settings' }, 503);
  }
});

// This is an explicit owner setup action. The model is not given navigation
// access; subsequent reads remain fenced to the requested origin.
routes.post('/webbridge-tab', async (c) => {
  if (process.platform !== 'darwin' || !deviceNodesEnabled())
    return c.json({ error: 'Local device setup unavailable' }, 409);
  const parsed = z
    .strictObject({
      url: z.url().max(2048),
      port: z.number().int().min(1).max(65535),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid browser target' }, 400);
  try {
    const target = new URL(parsed.data.url);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password
    )
      return c.json({ error: 'Invalid browser target' }, 400);
    const session = `opendot-${randomUUID()}`;
    const response = await fetch(
      `http://127.0.0.1:${parsed.data.port}/command`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          action: 'navigate',
          session,
          args: { url: target.href, newTab: true, group_title: 'OpenDot' },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error('Bridge unavailable');
    if (!response.body) throw new Error('Bridge response unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 131072) {
        await reader.cancel();
        throw new Error('Bridge response too large');
      }
      chunks.push(part.value);
    }
    const body = z
      .object({
        ok: z.literal(true),
        data: z
          .object({ tabId: z.number().int().positive().safe() })
          .passthrough(),
      })
      .passthrough()
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return c.json({ session, tabId: body.data.tabId, origin: target.origin });
  } catch {
    return c.json({ error: 'Unable to open the WebBridge tab' }, 503);
  }
});

const Start = z.strictObject({
  serverId: z
    .string()
    .regex(/^opendot_(?:kimicu|computer|webbridge)_[a-f0-9]{32}$/),
  pairCode: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
routes.get('/computer', (c) => {
  try {
    const ownerId = c.get('user').id;
    const binding = readComputerCapability(ownerId);
    const device =
      binding &&
      listPersonalDevices(ownerId).find((entry) => entry.id === binding.nodeId);
    return c.json({
      configured: !!device && device.state === 'active',
      online: !!device?.online,
    });
  } catch {
    return c.json({ error: 'Computer settings unavailable' }, 500);
  }
});
routes.delete('/computer', (c) => {
  try {
    const ownerId = c.get('user').id;
    const binding = readComputerCapability(ownerId);
    if (binding) {
      const device = listPersonalDevices(ownerId).find(
        (entry) => entry.id === binding.nodeId,
      );
      if (device && device.state !== 'revoked')
        revokePersonalDevice(ownerId, device.id, device.revision, randomUUID());
      const startup = starts.get(binding.serverId);
      if (startup?.ownerId === ownerId && startup.state !== 'exited')
        startup.child.kill('SIGTERM');
    }
    clearComputerCapability(ownerId);
    return c.json({ configured: false });
  } catch {
    return c.json({ error: 'Computer settings unavailable' }, 500);
  }
});
routes.post('/computer', async (c) => {
  if (!deviceNodesEnabled())
    return c.json({ error: 'Device nodes disabled' }, 409);
  const input = z
    .strictObject({
      serverId: z.string().regex(/^opendot_computer_[a-f0-9]{32}$/),
      nodeId: z.uuid(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'Invalid computer setup' }, 400);
  try {
    const ownerId = c.get('user').id;
    const previous = readComputerCapability(ownerId);
    if (
      previous?.nodeId === input.data.nodeId &&
      previous.serverId === input.data.serverId &&
      listPersonalDevices(ownerId).some(
        (entry) => entry.id === previous.nodeId && entry.state === 'active',
      )
    )
      return c.json({ configured: true });
    if (
      previous &&
      (previous.nodeId !== input.data.nodeId ||
        previous.serverId !== input.data.serverId)
    ) {
      const oldDevice = listPersonalDevices(ownerId).find(
        (entry) => entry.id === previous.nodeId,
      );
      if (oldDevice && oldDevice.state !== 'revoked')
        throw new Error('Disable existing computer capability first');
    }
    const startup = starts.get(input.data.serverId);
    if (!startup || startup.ownerId !== ownerId || startup.state !== 'starting')
      throw new Error('Local node unavailable');
    const device = listPersonalDevices(ownerId).find(
      (entry) => entry.id === input.data.nodeId,
    );
    if (
      !device ||
      device.manifest.capability !== 'mcp' ||
      !device.manifest.servers.some(
        (server) => server.server_id === input.data.serverId,
      )
    )
      throw new Error('Local device mismatch');
    const { definitions } = readStoredUserMcpServers(ownerId);
    const definition = definitions.servers[input.data.serverId];
    if (
      !definition ||
      definition.pi?.location.kind !== 'device' ||
      definition.pi.location.node_id !== device.id
    )
      throw new Error('Local declaration mismatch');
    if (device.state === 'pending')
      approvePersonalDevice(ownerId, device.id, device.revision, randomUUID());
    else if (device.state !== 'active') throw new Error('Device unavailable');
    saveComputerCapability({
      version: 1,
      ownerId,
      nodeId: device.id,
      serverId: input.data.serverId,
    });
    return c.json({ configured: true });
  } catch {
    return c.json({ error: 'Could not enable computer access' }, 409);
  }
});
routes.get('/status/:serverId', (c) => {
  const entry = starts.get(c.req.param('serverId'));
  if (!entry || entry.ownerId !== c.get('user').id)
    return c.json({ error: 'Local startup not found' }, 404);
  return c.json({ state: entry.state, code: entry.code });
});
routes.post('/stop/:serverId', (c) => {
  const entry = starts.get(c.req.param('serverId'));
  if (!entry || entry.ownerId !== c.get('user').id)
    return c.json({ error: 'Local startup not found' }, 404);
  if (entry.state !== 'exited') entry.child.kill('SIGTERM');
  return c.json({ stopRequested: true });
});
routes.post('/start', async (c) => {
  if (process.platform !== 'darwin' || !deviceNodesEnabled())
    return c.json({ error: 'Local device setup unavailable' }, 409);
  const parsed = Start.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: 'Invalid local device setup' }, 400);
  try {
    const p = localPaths();
    const ownerId = z.uuid().parse(c.get('user').id);
    const { definitions, secrets } = readStoredUserMcpServers(ownerId);
    const definition = definitions.servers[parsed.data.serverId];
    const secret = secrets.servers[parsed.data.serverId];
    const desktop = parsed.data.serverId.startsWith('opendot_kimicu_');
    const computer = parsed.data.serverId.startsWith('opendot_computer_');
    if ((desktop || computer) && !fs.existsSync('/Applications/KimiCU.app/Contents/MacOS/kimi-cu'))
      return c.json({ error: 'KimiCU is not installed' }, 409);
    const tools = desktop
      ? ['observe_window', 'act_on_window', 'capture_window']
      : computer
        ? [
            'list_windows',
            'open_application',
            'observe_window',
            'act_on_window',
          ]
        : ['read_page'];
    const prefix = p.loader ? ['--import', p.loader] : [];
    const expectedArgs = [
      ...prefix,
      desktop ? p.desktop : computer ? p.computer : p.browser,
    ];
    const env = secret?.env ?? {};
    const keys = desktop
      ? [
          'OPENDOT_KIMICU_APP_ID',
          'OPENDOT_KIMICU_PID',
          'OPENDOT_KIMICU_WINDOW_ID',
        ]
      : computer
        ? []
        : [
            'OPENDOT_WEBBRIDGE_SESSION',
            'OPENDOT_WEBBRIDGE_TAB_ID',
            'OPENDOT_WEBBRIDGE_ORIGIN',
            'OPENDOT_WEBBRIDGE_PORT',
          ];
    if (
      !definition ||
      !definition.enabled ||
      definition.command !== p.command ||
      JSON.stringify(definition.args) !== JSON.stringify(expectedArgs) ||
      definition.pi?.location.kind !== 'device' ||
      !definition.pi.enabled ||
      JSON.stringify(definition.pi.tools) !== JSON.stringify(tools) ||
      secret?.headers ||
      Object.keys(env).sort().join(',') !== keys.sort().join(',')
    )
      return c.json({ error: 'Local device declaration mismatch' }, 400);
    const pairDigest = createHash('sha256')
      .update(parsed.data.pairCode)
      .digest('hex');
    const previous = starts.get(parsed.data.serverId);
    if (previous) {
      if (
        previous.ownerId === ownerId &&
        previous.pairDigest === pairDigest &&
        previous.state === 'starting'
      )
        return c.json({ started: true });
      return c.json({ error: 'Local node startup already requested' }, 409);
    }
    if (starts.size >= 128)
      return c.json({ error: 'Local node startup limit reached' }, 429);
    const id = randomUUID();
    // DATA_DIR can itself be a user-selected symlink. The device loader
    // requires its private config to be opened through a real path.
    const directory = path.join(
      fs.realpathSync(DATA_DIR),
      'device-nodes',
      ownerId,
      id,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory)
      throw new Error('Device state directory must not contain symlinks');
    const config = path.join(directory, 'mcp.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        owner_id: ownerId,
        servers: [
          {
            server_id: parsed.data.serverId,
            cwd: p.root,
            definition: { ...definition, ...secret },
          },
        ],
      }),
      { mode: 0o600, flag: 'wx' },
    );
    // In an ephemeral-port deployment WEB_PORT can be zero; use the actual
    // accepted socket's local port rather than a request-controlled Host value.
    const socketPort = (
      c.env as { incoming?: { socket?: { localPort?: number } } } | undefined
    )?.incoming?.socket?.localPort;
    const gatewayPort = socketPort ?? WEB_PORT;
    if (
      !Number.isSafeInteger(gatewayPort) ||
      gatewayPort < 1 ||
      gatewayPort > 65535
    )
      throw new Error('Local gateway port unavailable');
    const child = spawn(
      p.command,
      [
        ...prefix,
        p.nodeScript,
        '--gateway',
        `http://127.0.0.1:${gatewayPort}`,
        '--state',
        path.join(directory, 'node.sqlite'),
        '--mcp-config',
        config,
        '--kimi-status',
        '--pair',
      ],
      {
        cwd: p.root,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
        },
      },
    );
    const status: {
      ownerId: string;
      pairDigest: string;
      state: 'starting' | 'exited';
      code?: number | null;
      child: ChildProcess;
    } = { ownerId, pairDigest, state: 'starting', child };
    starts.set(parsed.data.serverId, status);
    const markExited = (code: number | null) => {
      if (status.state === 'exited') return;
      status.state = 'exited';
      status.code = code;
      // Keep a short-lived terminal receipt for retry feedback, then release
      // the slot. Never evict a live child to make a duplicate start possible.
      setTimeout(() => {
        if (starts.get(parsed.data.serverId) === status)
          starts.delete(parsed.data.serverId);
      }, 10 * 60_000).unref();
    };
    child.on('error', () => markExited(null));
    child.on('exit', markExited);
    child.stdin.on('error', () => {});
    child.stdin.end(`${parsed.data.pairCode}\n`);
    child.unref();
    return c.json({ started: true });
  } catch {
    return c.json({ error: 'Could not start local device node' }, 500);
  }
});
export default routes;
