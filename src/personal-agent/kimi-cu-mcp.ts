/** Device-only scoped MCP adapter. The owner configures its exact target in the
 * paired node's approved MCP definition; no remote arguments select a target. */
import { createInterface } from 'node:readline';
import { McpClient, StdioTransport } from '@earendil-works/pi-mcp';
import { KimiCuBackend } from './kimi-cu-backend.js';
import { KimiDesktopTargetPolicy } from './kimi-desktop-target-policy.js';
import { KimiCuToolSession } from './kimi-cu-tool-session.js';
import { kimiCuDeviceLock } from './kimi-cu-device-lock.js';

const appId = process.env.OPENDOT_KIMICU_APP_ID ?? '';
const pid = Number(process.env.OPENDOT_KIMICU_PID);
const windowId = Number(process.env.OPENDOT_KIMICU_WINDOW_ID);
if (process.platform !== 'darwin')
  throw new Error('KimiCU device configuration unavailable');
const client = new McpClient({
  name: 'opendot-kimicu-scoped',
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
const backend = new KimiCuBackend(client, { appId, pid, windowId });
const policy = new KimiDesktopTargetPolicy({
  ...kimiCuDeviceLock(),
  allowedApps: [appId],
  backend,
  // This process must only be offered through the owner-authorized device MCP
  // channel. That channel checks the current grant and exact-argument approval.
  authorize() {},
});
const session = new KimiCuToolSession(policy);
const tools = [
  {
    name: 'observe_window',
    description: 'Observe the owner-selected application window.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'capture_window',
    annotations: { 'opendot.requiresImageGrant': true },
    description:
      'Capture the owner-selected application window; requires a separate image grant.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'act_on_window',
    description: 'Perform one approved action using a fresh observation token.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', format: 'uuid' },
        action: { enum: ['click', 'set_value'] },
        index: { type: 'integer', minimum: 0 },
        value: { type: 'string', maxLength: 4096 },
      },
      required: ['token', 'action', 'index'],
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
    let result: unknown;
    try {
      if (request.method === 'initialize')
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'opendot-kimicu-scoped', version: '1' },
        };
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'tools/call') {
        const value = await session.call(
          request.params.name,
          request.params.arguments,
        );
        const { image, ...text } = value as typeof value & {
          image?: { type: 'image'; mimeType: string; data: string };
        };
        result = {
          content: [
            { type: 'text', text: JSON.stringify(text) },
            ...(image ? [image] : []),
          ],
        };
      } else throw new Error('Unsupported request');
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
      );
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: 'Scoped KimiCU operation unavailable',
          },
        }) + '\n',
      );
    }
  }
} finally {
  await client.close();
}
