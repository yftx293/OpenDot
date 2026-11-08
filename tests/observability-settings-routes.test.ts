import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-observability-route-'));
vi.mock('../src/config.js', async (original) => ({ ...(await original<Record<string, unknown>>()), DATA_DIR: root }));
vi.mock('../src/middleware/auth.js', () => ({ authMiddleware: async (c: any, next: () => Promise<void>) => {
  c.set('user', { id: 'fixture-owner', role: c.req.header('x-role') || 'member' });
  await next();
} }));
const routes = (await import('../src/routes/observability.js')).default;
const app = new Hono().route('/api/observability', routes);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('only administrators may configure Langfuse and keys never return to the page', async () => {
  const body = { enabled: true, origin: 'https://example.test', sampleRate: 0.25, publicKey: 'pk-test-fixture', secretKey: 'sk-test-fixture' };
  const call = (role: string, method: string, payload?: unknown) => app.request('/api/observability', {
    method, headers: { 'x-role': role, 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  expect((await call('member', 'PUT', body)).status).toBe(403);
  expect((await app.request('/api/observability/test', { method: 'POST', headers: { 'x-role': 'member' } })).status).toBe(403);
  const saved = await call('admin', 'PUT', body);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ configured: true, enabled: true, origin: body.origin, sampleRate: 0.25, restartRequired: true });
  const read = await call('admin', 'GET');
  const publicBody = await read.text();
  expect(read.headers.get('cache-control')).toBe('no-store');
  expect(publicBody).not.toContain(body.publicKey);
  expect(publicBody).not.toContain(body.secretKey);
  expect(fs.readFileSync(path.join(root, 'config/langfuse-observability.json'), 'utf8')).not.toContain(body.secretKey);
  expect((await call('admin', 'PUT', { enabled: false, origin: body.origin, sampleRate: 1 })).status).toBe(200);
  expect((await call('admin', 'PUT', { ...body, origin: 'http://example.test' })).status).toBe(400);
  expect((await call('member', 'DELETE')).status).toBe(403);
  const removed = await call('admin', 'DELETE');
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ configured: false, enabled: false, restartRequired: true });
  expect(fs.existsSync(path.join(root, 'config/langfuse-observability.json'))).toBe(false);
});
