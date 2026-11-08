import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from 'vitest';
import { botHandoffHttpFixture, waitFor } from './helpers/bot-handoff-http-fixture.js';

test('paired node negotiates and reports KimiCU diagnosis without granting control', async () => {
  const f = await botHandoffHttpFixture(undefined, { MINICLAW_DEVICE_NODES: 'true' });
  let node: ChildProcess | undefined;
  let legacyHost = false, rejectedExtended = 0, recoveredLegacy = 0;
  const gateway = http.createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const heartbeat = request.method === 'POST' && request.url === '/api/device-nodes/transport/heartbeat';
      const extended = heartbeat && !!JSON.parse(body.toString('utf8')).kimi_readiness?.computerUse;
      if (legacyHost && extended) {
        rejectedExtended++;
        response.writeHead(400, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (legacyHost && heartbeat && rejectedExtended) recoveredLegacy++;
      const upstream = await fetch(f.origin + request.url, {
        method: request.method,
        headers: { authorization: request.headers.authorization ?? '', ...(body.length ? { 'content-type': 'application/json' } : {}) },
        ...(body.length ? { body } : {}),
        redirect: 'error',
      });
      let payload = Buffer.from(await upstream.arrayBuffer());
      if (legacyHost && heartbeat && upstream.ok) {
        const parsed = JSON.parse(payload.toString('utf8'));
        delete parsed.capabilities;
        payload = Buffer.from(JSON.stringify(parsed));
      }
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }).end(payload);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  try {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const gatewayAddress = gateway.address();
    if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('Fixture gateway unavailable');
    const root = path.join(f.root, 'synthetic-device');
    const home = path.join(f.root, 'device-home');
    fs.mkdirSync(root); fs.mkdirSync(home);
    fs.writeFileSync(path.join(root, 'fixture.txt'), 'synthetic');
    const { ticket } = await f.json<any>(await f.call('/api/device-nodes/pair-tickets', 'POST', { name: 'Kimi readiness fixture' }));
    node = spawn(process.execPath, [
      '--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('scripts/device-node.ts'),
      '--gateway', `http://127.0.0.1:${gatewayAddress.port}`, '--state', path.join(f.root, 'node-private/node.sqlite'),
      '--root', root, '--allow-file', 'fixture.txt', '--pair', '--kimi-status',
    ], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'ignore'] });
    node.stdin?.end(ticket.pair_code + '\n');
    let device: any;
    await waitFor(async () => {
      device = (await f.json<any>(await f.call('/api/device-nodes'))).devices[0];
      return !!device;
    });
    await f.json(await f.call(`/api/device-nodes/${device.id}/approve`, 'POST', { confirmed: true, expected_revision: device.revision }));
    await waitFor(async () => {
      device = (await f.json<any>(await f.call('/api/device-nodes'))).devices[0];
      return !!device?.kimi_readiness?.computerUse;
    }, 30000);
    expect(device.online).toBe(true);
    expect(device.kimi_readiness.computerUse.permissions).toBe('unknown');
    expect(device.kimi_readiness.computerUse.scopedControlAvailable).toBe(false);
    expect(device.kimi_readiness.scopedControlAvailable).toBe(false);
    expect(JSON.stringify(device.kimi_readiness)).not.toContain(f.root);
    legacyHost = true;
    await waitFor(() => rejectedExtended > 0 && recoveredLegacy > 0, 30000);
    await waitFor(async () => {
      device = (await f.json<any>(await f.call('/api/device-nodes'))).devices[0];
      return device?.online && device.kimi_readiness && !device.kimi_readiness.computerUse;
    }, 30000);
    legacyHost = false;
    await waitFor(async () => {
      device = (await f.json<any>(await f.call('/api/device-nodes'))).devices[0];
      return !!device?.kimi_readiness?.computerUse;
    }, 30000);
  } finally {
    if (node && node.exitCode === null) {
      node.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => node!.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (node.exitCode === null) node.kill('SIGKILL');
    }
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await f.dispose();
  }
}, 120000);
