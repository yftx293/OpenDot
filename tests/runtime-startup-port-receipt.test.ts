import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, test } from 'vitest';
import { botHandoffHttpFixture } from './helpers/bot-handoff-http-fixture.js';

test('startup identifies the healthy Web listener instead of the first auxiliary listener in the owned process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-aux-port-'));
  const preload = path.join(root, 'aux.mjs');
  fs.writeFileSync(
    preload,
    `import {createServer} from 'node:http';
const auxiliary=createServer((_request,response)=>{response.writeHead(404);response.end('NOT_PRODUCT_WEB');});
await new Promise(resolve=>auxiliary.listen(0,'127.0.0.1',resolve));
process.once('SIGTERM',()=>auxiliary.close());`,
  );
  let fixture: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  try {
    fixture = await botHandoffHttpFixture(preload, {}, 30000);
    expect((await fixture.call('/api/health')).status).toBe(200);
    expect((await fixture.call('/api/auth/me')).status).toBe(200);
  } finally {
    await fixture?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
