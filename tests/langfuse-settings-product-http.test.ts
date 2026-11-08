import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { botHandoffHttpFixture, waitFor } from './helpers/bot-handoff-http-fixture.js';

test('saved Langfuse settings load after restart and export metadata to the configured project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-langfuse-https-'));
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 30000 });
  expect(generated.status).toBe(0);
  const payloads: string[] = [];
  const expectedAuth = `Basic ${Buffer.from('synthetic-public-key:synthetic-langfuse-secret').toString('base64')}`;
  let acceptedHeaders = false;
  let rejectRequests = false;
  let redirectProjects = false;
  let redirectTargetHits = 0;
  const collector = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    if (request.url === '/redirect-target') { redirectTargetHits++; response.writeHead(200).end(); return; }
    if (rejectRequests || request.headers.authorization !== expectedAuth || (request.url === '/api/public/otel/v1/traces' && request.headers['x-langfuse-ingestion-version'] !== '4')) {
      response.writeHead(401).end();
      request.resume();
      return;
    }
    acceptedHeaders = true;
    if (request.url === '/api/public/projects') {
      if (redirectProjects) { response.writeHead(302, { location: '/redirect-target' }).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'synthetic-project' }] }));
      return;
    }
    const chunks: Buffer[] = []; let size = 0;
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => { if (request.url === '/api/public/otel/v1/traces') payloads.push(Buffer.concat(chunks).toString('utf8')); response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  try {
    const port = (collector.address() as { port: number }).port;
    f = await botHandoffHttpFixture(undefined, { NODE_EXTRA_CA_CERTS: cert });
    const secret = 'synthetic-langfuse-secret';
    const saved = await f.json<any>(await f.call('/api/observability', 'PUT', {
      enabled: true, origin: `https://127.0.0.1:${port}`, sampleRate: 1,
      publicKey: 'synthetic-public-key', secretKey: secret,
    }));
    expect(saved.restartRequired).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(await f.json<any>(await f.call('/api/observability/test', 'POST', {}))).toEqual({ result: 'authenticated' });
    redirectProjects = true;
    expect(await f.json<any>(await f.call('/api/observability/test', 'POST', {}))).toEqual({ result: 'unavailable' });
    expect(redirectTargetHits).toBe(0);
    redirectProjects = false;
    expect((await f.json<any>(await f.call('/api/observability'))).restartRequired).toBe(true);
    await f.stop(); await f.start();
    const active = await f.json<any>(await f.call('/api/observability'));
    expect(active).toMatchObject({ active: true, enabled: true, configured: true, restartRequired: false });
    expect(JSON.stringify(active)).not.toContain(secret);
    const options = await f.json<any>(await f.call('/api/bot-groups/options'));
    const jid = options.workspaces[0].jid;
    const session = (await f.json<any>(await f.call(`/api/groups/${encodeURIComponent(jid)}/sessions`, 'POST', { name: 'Synthetic trace', runtime: 'node-durable' }))).session.id;
    f.setModel(() => ({ text: 'PRIVATE_SYNTHETIC_ANSWER' }));
    await f.json(await f.call('/api/messages', 'POST', { chatJid: jid, agentId: session, requestId: randomUUID(), content: 'PRIVATE_SYNTHETIC_QUESTION', followUpBehavior: 'queue' }));
    await waitFor(() => payloads.some((value) => value.includes('dot.model.generation')), 60000);
    expect(acceptedHeaders).toBe(true);
    await waitFor(async () => (await f!.json<any>(await f!.call('/api/observability'))).exportCounts?.exported > 0, 10000);
    const exported = payloads.join('\n');
    expect(exported).not.toContain('PRIVATE_SYNTHETIC_QUESTION');
    expect(exported).not.toContain('PRIVATE_SYNTHETIC_ANSWER');
    expect(exported).not.toContain(secret);
    // A server-side rejection must be visible in settings.
    rejectRequests = true;
    expect(await f.json<any>(await f.call('/api/observability/test', 'POST', {}))).toEqual({ result: 'unauthorized' });
    await f.json(await f.call('/api/messages', 'POST', { chatJid: jid, agentId: session, requestId: randomUUID(), content: 'PRIVATE_SECOND_QUESTION', followUpBehavior: 'queue' }));
    await waitFor(async () => (await f!.json<any>(await f!.call('/api/observability'))).exportCounts?.failed > 0, 30000);
    const removed = await f.json<any>(await f.call('/api/observability', 'DELETE'));
    expect(removed).toMatchObject({ configured: false, enabled: false, active: true, restartRequired: true });
    expect(JSON.stringify(removed)).not.toContain(secret);
    expect((await f.json<any>(await f.call('/api/observability'))).restartRequired).toBe(true);
    await f.stop(); await f.start();
    const afterRestart = await f.json<any>(await f.call('/api/observability'));
    expect(afterRestart).toMatchObject({ configured: false, enabled: false, active: false, restartRequired: false });
  } finally {
    await f?.dispose();
    await new Promise<void>((resolve) => { collector.close(() => resolve()); collector.closeAllConnections(); });
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
