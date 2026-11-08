import readline from 'node:readline';
import fs from 'node:fs';

const record = (value) =>
  fs.appendFileSync(process.env.MCP_TEST_LEDGER, JSON.stringify(value) + '\n');
record({
  event: 'start',
  pid: process.pid,
  home: process.env.HOME ?? null,
  canary: process.env.MCP_PARENT_SECRET ?? null,
});
let listings = 0;
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') {
    if (process.env.MCP_TEST_INITIALIZE_DELAY_MS)
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.MCP_TEST_INITIALIZE_DELAY_MS)),
      );
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    };
  } else if (request.method === 'tools/list') {
    listings++;
    if (process.env.MCP_TEST_LIST_ERROR && listings > 1) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: 'MCP_PRIVATE_ERROR_CANARY' },
        }) + '\n',
      );
      continue;
    }
    result = {
      tools: [
        {
          name: 'echo',
          description:
            process.env.MCP_TEST_CHANGE && listings > 1 ? 'changed' : 'echo',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', maxLength: 100 } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
    };
  } else if (request.method === 'tools/call') {
    record({
      event: 'call',
      name: request.params.name,
      args: request.params.arguments,
    });
    if (process.env.MCP_TEST_LOST_ACK) process.exit(0);
    if (process.env.MCP_TEST_HOLD_ACK) continue;
    if (process.env.MCP_TEST_DELAY_MS)
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.MCP_TEST_DELAY_MS)),
      );
    result = {
      content: [{ type: 'text', text: request.params.arguments.text }],
      ...(process.env.MCP_TEST_ERROR ? { isError: true } : {}),
    };
  } else result = {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
  );
}
