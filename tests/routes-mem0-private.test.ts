import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-mem0-private-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'mem0-private-http-test-signing-secret',
}));
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const routes = (await import('../src/routes/mem0-private.js')).default;
const app = new Hono().route('/api/mem0-private', routes);
const cookies = new Map<string, string>();

beforeAll(() => {
  db.initDatabase();
  for (const id of ['mem0-alice', 'mem0-bob']) {
    const now = new Date().toISOString();
    db.createUser({
      id,
      username: id,
      password_hash: 'fixture',
      display_name: id,
      role: 'member',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: id,
      ip_address: null,
      user_agent: null,
      created_at: now,
      last_active_at: now,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    cookies.set(id, `miniclaw_session=${auth.signSessionToken(token)}`);
    db.getOrCreateDefaultAgentProfile(id);
  }
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

const headers = (owner: string) => ({
  cookie: cookies.get(owner)!,
  'content-type': 'application/json',
});

it('requires authentication and never returns either owner credential', async () => {
  expect((await app.request('/api/mem0-private')).status).toBe(401);
  const key = 'mem0-private-fixture-secret';
  const save = await app.request('/api/mem0-private/credential', {
    method: 'PUT',
    headers: headers('mem0-alice'),
    body: JSON.stringify({ apiKey: key }),
  });
  expect(save.status).toBe(200);
  const alice = await app.request('/api/mem0-private', {
    headers: headers('mem0-alice'),
  });
  expect(alice.headers.get('cache-control')).toBe('no-store');
  const aliceBody = await alice.text();
  expect(aliceBody).not.toContain(key);
  expect(JSON.parse(aliceBody)).toMatchObject({ credentialConfigured: true });
  const bob = await app.request('/api/mem0-private', {
    headers: headers('mem0-bob'),
  });
  expect(await bob.json()).toMatchObject({ credentialConfigured: false });
});

it('binds policy writes to the signed-in Dot owner and rejects malformed bodies', async () => {
  const alice = (await (
    await app.request('/api/mem0-private', {
      headers: headers('mem0-alice'),
    })
  ).json()) as { dots: Array<{ id: string; policy: { enabled: boolean } }> };
  const dotId = alice.dots[0]!.id;
  expect(alice.dots[0]!.policy.enabled).toBe(false);
  const url = `/api/mem0-private/dots/${dotId}`;
  const denied = await app.request(url, {
    method: 'PUT',
    headers: headers('mem0-bob'),
    body: JSON.stringify({
      enabled: true,
      recallEnabled: true,
      captureEnabled: true,
    }),
  });
  expect(denied.status).toBe(404);
  const invalid = await app.request(url, {
    method: 'PUT',
    headers: headers('mem0-alice'),
    body: JSON.stringify({ enabled: true, recallEnabled: true }),
  });
  expect(invalid.status).toBe(400);
  const saved = await app.request(url, {
    method: 'PUT',
    headers: headers('mem0-alice'),
    body: JSON.stringify({
      enabled: true,
      recallEnabled: true,
      captureEnabled: false,
    }),
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    policy: { enabled: true, recallEnabled: true, captureEnabled: false },
  });
  const bob = await app.request('/api/mem0-private', {
    headers: headers('mem0-bob'),
  });
  expect(JSON.stringify(await bob.json())).not.toContain(dotId);
  const clear = await app.request('/api/mem0-private/credential', {
    method: 'DELETE',
    headers: headers('mem0-alice'),
  });
  expect(clear.status).toBe(200);
  expect(await clear.json()).toEqual({ credentialConfigured: false });
});
