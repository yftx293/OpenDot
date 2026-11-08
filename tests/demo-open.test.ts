import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-open-'));
const previousEnv = {
  WEB_SESSION_SECRET: process.env.WEB_SESSION_SECRET,
  MINICLAW_DEMO_OPEN: process.env.MINICLAW_DEMO_OPEN,
  TRUST_PROXY: process.env.TRUST_PROXY,
  MINICLAW_DEMO_ADMIN_USERNAME: process.env.MINICLAW_DEMO_ADMIN_USERNAME,
  MINICLAW_DEMO_ADMIN_PASSWORD: process.env.MINICLAW_DEMO_ADMIN_PASSWORD,
};
process.env.WEB_SESSION_SECRET =
  previousEnv.WEB_SESSION_SECRET ||
  'demo-open-test-secret-demo-open-test-secret';
delete process.env.MINICLAW_DEMO_OPEN;
delete process.env.TRUST_PROXY;
delete process.env.MINICLAW_DEMO_ADMIN_USERNAME;
delete process.env.MINICLAW_DEMO_ADMIN_PASSWORD;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: path.join(tmpDir, 'data'),
    STORE_DIR: path.join(tmpDir, 'data', 'db'),
    GROUPS_DIR: path.join(tmpDir, 'data', 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const { Hono } = await import('hono');
const db = await import('../src/db.js');
const { generateSessionToken, hashPassword, signSessionToken, verifyPassword } =
  await import('../src/auth.js');
const { authMiddleware, demoOpenSessionMiddleware } =
  await import('../src/middleware/auth.js');
const demoOpen = await import('../src/demo-open.js');

function restoreEnv(
  key: keyof typeof previousEnv,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(() => {
  restoreEnv('WEB_SESSION_SECRET', previousEnv.WEB_SESSION_SECRET);
  restoreEnv('MINICLAW_DEMO_OPEN', previousEnv.MINICLAW_DEMO_OPEN);
  restoreEnv('TRUST_PROXY', previousEnv.TRUST_PROXY);
  restoreEnv(
    'MINICLAW_DEMO_ADMIN_USERNAME',
    previousEnv.MINICLAW_DEMO_ADMIN_USERNAME,
  );
  restoreEnv(
    'MINICLAW_DEMO_ADMIN_PASSWORD',
    previousEnv.MINICLAW_DEMO_ADMIN_PASSWORD,
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'data', 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'data', 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  delete process.env.MINICLAW_DEMO_OPEN;
  delete process.env.TRUST_PROXY;
  demoOpen.resetDemoOpenStateForTests();
});

function buildApp(options?: { documentMiddleware?: boolean }) {
  const app = new Hono();
  if (options?.documentMiddleware !== false) {
    app.use('*', demoOpenSessionMiddleware);
  }
  app.get('/api/auth/me', authMiddleware, (c) => {
    const user = c.get('user') as { username: string; role: string };
    return c.json({ username: user.username, role: user.role });
  });
  app.get('/api/cloud-runtime/ping', (c) => {
    return c.json({ ok: true });
  });
  app.get('/', (c) => c.text('shell'));
  return app;
}

function request(
  app: ReturnType<typeof buildApp>,
  path: string,
  options: {
    peer?: string | null;
    xff?: string;
    realIp?: string;
    cookie?: string;
    demo?: boolean;
    trustProxy?: boolean;
  } = {},
) {
  if (options.demo) process.env.MINICLAW_DEMO_OPEN = 'true';
  else delete process.env.MINICLAW_DEMO_OPEN;
  if (options.trustProxy) process.env.TRUST_PROXY = 'true';
  else delete process.env.TRUST_PROXY;
  const headers: Record<string, string> = {};
  if (options.xff) headers['x-forwarded-for'] = options.xff;
  if (options.realIp) headers['x-real-ip'] = options.realIp;
  if (options.cookie) headers.cookie = options.cookie;
  const env =
    options.peer === null
      ? {}
      : {
          incoming: { socket: { remoteAddress: options.peer ?? '127.0.0.1' } },
        };
  return app.request(path, { headers }, env);
}

describe('demo open connection policy', () => {
  test('accepts only loopback peers, and forwarded clients only from a trusted loopback proxy', () => {
    expect(demoOpen.isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(demoOpen.isLoopbackAddress('::1')).toBe(true);
    expect(demoOpen.isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(demoOpen.isLoopbackAddress('[::1]')).toBe(true);
    expect(demoOpen.isLoopbackAddress('203.0.113.5')).toBe(false);
    expect(demoOpen.isLoopbackAddress('localhost')).toBe(false);

    const allow = (
      remoteAddress: string,
      trustProxy: boolean,
      forwardedFor?: string,
      realIp?: string,
    ) =>
      demoOpen.isEligibleDemoConnection({
        remoteAddress,
        trustProxy,
        forwardedFor: forwardedFor ?? null,
        realIp: realIp ?? null,
      });

    expect(allow('127.0.0.1', false)).toBe(true);
    expect(allow('127.0.0.1', false, '203.0.113.5')).toBe(true);
    expect(allow('203.0.113.5', true, '127.0.0.1')).toBe(false);
    expect(allow('127.0.0.1', true, '203.0.113.5')).toBe(false);
    expect(allow('127.0.0.1', true, '203.0.113.5, 127.0.0.1')).toBe(false);
    expect(allow('127.0.0.1', true, '127.0.0.1')).toBe(true);
    expect(allow('::1', true)).toBe(true);
    expect(allow('127.0.0.1', true, undefined, '198.51.100.20')).toBe(false);
  });
});

describe('demo open session middleware', () => {
  test('stays closed unless MINICLAW_DEMO_OPEN=true, including for loopback', async () => {
    const app = buildApp();
    const res = await request(app, '/api/auth/me', {
      peer: '127.0.0.1',
      demo: false,
    });
    expect(res.status).toBe(401);
    expect(db.getUserCount(true)).toBe(0);
  });

  test('does not authenticate a remote peer or a spoofed forwarding header', async () => {
    const app = buildApp();
    const remote = await request(app, '/api/auth/me', {
      peer: '203.0.113.5',
      xff: '127.0.0.1',
      demo: true,
      trustProxy: true,
    });
    expect(remote.status).toBe(401);

    const missingPeer = await request(app, '/api/auth/me', {
      peer: null,
      demo: true,
    });
    expect(missingPeer.status).toBe(401);
    expect(db.getUserCount(true)).toBe(0);
  });

  test('seeds a demo admin and authenticates loopback, including via auth middleware alone', async () => {
    const app = buildApp({ documentMiddleware: false });
    const res = await request(app, '/api/auth/me', {
      peer: '::ffff:127.0.0.1',
      demo: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: 'admin', role: 'admin' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('miniclaw_session=');
    expect(setCookie).toContain('HttpOnly');

    const admin = db.getUserByUsername('admin');
    expect(admin?.role).toBe('admin');
    expect(admin?.must_change_password).toBe(false);
    expect(admin?.notes).toBe('Created by MINICLAW_DEMO_OPEN');
    expect(
      await verifyPassword(
        demoOpen.DEFAULT_DEMO_ADMIN_PASSWORD,
        admin!.password_hash,
      ),
    ).toBe(true);
    expect(db.getUserHomeGroup(admin!.id)).toBeTruthy();
  });

  test('reuses the demo admin for other loopback forms and ignores untrusted forwarding', async () => {
    const app = buildApp();
    for (const peer of ['127.0.0.1', '::1']) {
      const res = await request(app, '/api/auth/me', { peer, demo: true });
      expect(res.status).toBe(200);
      expect((await res.json()).role).toBe('admin');
    }

    const ignoredForward = await request(app, '/api/auth/me', {
      peer: '127.0.0.1',
      xff: '203.0.113.5',
      demo: true,
      trustProxy: false,
    });
    expect(ignoredForward.status).toBe(200);

    const proxiedRemote = await request(app, '/api/auth/me', {
      peer: '127.0.0.1',
      xff: '203.0.113.8',
      demo: true,
      trustProxy: true,
    });
    expect(proxiedRemote.status).toBe(401);

    const proxiedLocal = await request(app, '/api/auth/me', {
      peer: '127.0.0.1',
      xff: '127.0.0.1',
      demo: true,
      trustProxy: true,
    });
    expect(proxiedLocal.status).toBe(200);

    const realIpRemote = await request(app, '/api/auth/me', {
      peer: '127.0.0.1',
      realIp: '198.51.100.8',
      demo: true,
      trustProxy: true,
    });
    expect(realIpRemote.status).toBe(401);
  });

  test('sets the cookie on the document response and does not attach it to cloud runtime', async () => {
    const app = buildApp();
    const page = await request(app, '/', { peer: '127.0.0.1', demo: true });
    expect(page.status).toBe(200);
    expect(page.headers.get('set-cookie') ?? '').toContain('miniclaw_session=');

    const cloud = await request(app, '/api/cloud-runtime/ping', {
      peer: '127.0.0.1',
      demo: true,
    });
    expect(cloud.status).toBe(200);
    expect(cloud.headers.get('set-cookie')).toBeNull();
  });

  test('keeps an existing non-admin session instead of replacing it', async () => {
    const now = new Date().toISOString();
    const userId = 'user-member-demo-open';
    db.createUser({
      id: userId,
      username: 'member',
      password_hash: await hashPassword('member-password'),
      display_name: 'member',
      role: 'member',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const token = generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: userId,
      ip_address: '127.0.0.1',
      user_agent: 'vitest',
      created_at: now,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      last_active_at: now,
    });
    const app = buildApp();
    const res = await request(app, '/api/auth/me', {
      peer: '127.0.0.1',
      demo: true,
      cookie: `miniclaw_session=${signSessionToken(token)}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: 'member', role: 'member' });
  });

  test('does not promote a database that has users but no active admin', async () => {
    const admin = db.getUserByUsername('admin');
    expect(admin).toBeTruthy();
    db.updateUserFields(admin!.id, { status: 'disabled' });
    demoOpen.resetDemoOpenStateForTests();
    const app = buildApp();
    const res = await request(app, '/api/auth/me', {
      peer: '127.0.0.1',
      demo: true,
    });
    expect(res.status).toBe(401);
    expect(db.getEarliestActiveAdmin()).toBeUndefined();
    db.updateUserFields(admin!.id, { status: 'active' });
  });
});
