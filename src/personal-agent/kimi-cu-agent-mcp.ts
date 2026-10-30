/** Device-local computer tools. Each invocation is separately authorized by
 * the paired device MCP channel before it reaches this process. */
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { McpClient, StdioTransport } from '@earendil-works/pi-mcp';
import { KimiCuBackend } from './kimi-cu-backend.js';
import { KimiDesktopTargetPolicy } from './kimi-desktop-target-policy.js';
import { KimiCuToolSession } from './kimi-cu-tool-session.js';
import { KimiCuAgentSession } from './kimi-cu-agent-session.js';
import { KimiCuWindowDiscovery } from './kimi-cu-window-discovery.js';
import { kimiCuDeviceLock } from './kimi-cu-device-lock.js';
import { classifyComputerError } from './computer-approval-policy.js';

if (process.platform !== 'darwin') throw new Error('macOS required');
const exec = promisify(execFile);
const client = new McpClient({
  name: 'opendot-kimicu-agent',
  version: '1',
  capabilities: {},
  requestTimeoutMs: 10000,
});
client.onError(() => {});
const transport = new StdioTransport({
  command: '/Applications/KimiCU.app/Contents/MacOS/kimi-cu',
  args: ['mcp'],
  cwd: '/',
  inheritEnv: false,
  env: {},
  stderr: 'pipe',
  maxMessageBytes: 6000000,
  maxStderrBytes: 4096,
  closeTimeoutMs: 1000,
});
const discovery = new KimiCuWindowDiscovery(async () => {
  const { stdout } = await exec(
    '/usr/bin/swift',
    [path.join(process.cwd(), 'scripts/list-kimicu-windows.swift')],
    { timeout: 15000, maxBuffer: 128 * 1024 },
  );
  return JSON.parse(stdout);
});
const session = new KimiCuAgentSession(
  discovery,
  (window) =>
    new KimiCuToolSession(
      new KimiDesktopTargetPolicy({
        ...kimiCuDeviceLock(),
        allowedApps: [window.appId],
        observationTtlMs: 120000,
        backend: new KimiCuBackend(client, {
          appId: window.appId,
          pid: window.pid,
          windowId: window.windowId,
        }),
        authorize() {}, // The device channel checks grants and exact-call approvals.
      }),
    ),
  async (application) => {
    await exec('/usr/bin/open', ['-a', application], { timeout: 15000 });
  },
);

const tools = [
  {
    name: 'list_windows',
    description:
      'List visible local application windows using temporary handles; optionally filter by application name and window title.',
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', minLength: 1, maxLength: 120 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'open_application',
    description: 'Open a local application by name. Requires approval.',
    inputSchema: {
      type: 'object',
      properties: { application: { type: 'string', maxLength: 120 } },
      required: ['application'],
      additionalProperties: false,
    },
  },
  {
    name: 'observe_window',
    description:
      'Observe a window from the latest list before acting. Pass its handle and exact label from the list.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', format: 'uuid' },
        label: { type: 'string', maxLength: 403 },
      },
      required: ['window', 'label'],
      additionalProperties: false,
    },
  },
  {
    name: 'act_on_window',
    description:
      'Click, set a value, or type and optionally submit using a fresh observation token, the same exact window label, and the exact observed element line. Requires approval. After submitting, observe the result before reporting success.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', format: 'uuid' },
        label: { type: 'string', maxLength: 403 },
        element: { type: 'string', maxLength: 1000 },
        action: { enum: ['click', 'set_value', 'type_text'] },
        index: { type: 'integer', minimum: 0 },
        value: { type: 'string', maxLength: 4096 },
        text: { type: 'string', maxLength: 4096 },
        clear: { type: 'boolean' },
        submit: { type: 'boolean' },
      },
      required: ['token', 'label', 'element', 'action', 'index'],
      additionalProperties: false,
    },
  },
];
await client.connect(transport);
try {
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    if (Buffer.byteLength(line) > 65536) break;
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      break;
    }
    if (request.id === undefined) continue;
    try {
      let result: unknown;
      if (request.method === 'initialize')
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'opendot-computer', version: '1' },
        };
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'tools/call')
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                await session.call(
                  request.params.name,
                  request.params.arguments,
                ),
              ),
            },
          ],
        };
      else throw new Error('Unsupported request');
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
      );
    } catch (error) {
      const typed = classifyComputerError(error);
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: typed.message,
            data: { code: typed.code },
          },
        }) + '\n',
      );
    }
  }
} finally {
  await client.close();
}
