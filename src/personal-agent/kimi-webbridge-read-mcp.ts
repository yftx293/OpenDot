/** Device-only experimental read adapter. Configuration is fixed in the
 * owner-approved device MCP declaration. It never accepts a model-selected
 * session, tab, origin, endpoint, selector, script or navigation target. */
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  KimiWebBridgeGuardedReader,
  loopbackWebBridge,
} from './kimi-webbridge-guarded-read.js';

const session = process.env.OPENDOT_WEBBRIDGE_SESSION ?? '';
if (
  !/^opendot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    session,
  )
)
  throw new Error('Dedicated WebBridge session required');
const reader = new KimiWebBridgeGuardedReader(
  loopbackWebBridge(Number(process.env.OPENDOT_WEBBRIDGE_PORT)),
  {
    session,
    tabId: Number(process.env.OPENDOT_WEBBRIDGE_TAB_ID),
    origin: process.env.OPENDOT_WEBBRIDGE_ORIGIN,
  },
);
const Empty = z.object({}).strict();
const tools = [
  {
    name: 'read_page',
    description:
      'Read text from the locally configured browser tab and origin.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];
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
        serverInfo: { name: 'opendot-webbridge-scoped-read', version: '1' },
      };
    else if (request.method === 'tools/list') result = { tools };
    else if (
      request.method === 'tools/call' &&
      request.params.name === 'read_page'
    ) {
      Empty.parse(request.params.arguments);
      result = {
        content: [{ type: 'text', text: JSON.stringify(await reader.read()) }],
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
        error: { code: -32000, message: 'Scoped WebBridge read unavailable' },
      }) + '\n',
    );
  }
}
