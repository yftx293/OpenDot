import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseOptions,
  tailnetOrigin,
  checkServeConfig,
} from '../scripts/pocket-access.mjs';

// Use the repository's existing TypeScript dependency; no browser/provider is
// required. Tests execute transpiled production modules, not copied models.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-pocket-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function loadTS(relative, name) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
    reportDiagnostics: true,
    fileName: relative,
  });
  assert.equal(
    result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error)
      .length,
    0,
  );
  const destination = path.join(temporary, `${name}.mjs`);
  fs.writeFileSync(destination, result.outputText);
  return import(pathToFileURL(destination).href);
}
const { WsManager, bindConnectionLifecycle } = await loadTS(
  'web/src/api/ws-manager.ts',
  'ws-manager',
);
const {
  sessionRoute,
  sessionLink,
  initialHashRoute,
  isExplicitMainSession,
  publicOrigin,
  isLoopbackOrigin,
} = await loadTS('web/src/features/pocket/continuity.ts', 'continuity');

class Socket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  closed = 0;
  sent = [];
  close() {
    this.closed++;
    this.readyState = 3;
  }
  send(data) {
    this.sent.push(data);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

function harness(t) {
  let online = true;
  const sockets = [];
  const errors = [];
  let authFailures = 0;
  let now = 0;
  let next = 1;
  const timers = new Map();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay) => {
    const id = next++;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const manager = new WsManager({
    createSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    isOnline: () => online,
    onAuthFailure: () => authFailures++,
    reportError: (error) => errors.push(error),
    random: () => 0.5,
  });
  t.after(() => {
    manager.disconnect();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  });
  return {
    manager,
    sockets,
    errors,
    timers,
    authFailures: () => authFailures,
    online(value) {
      online = value;
      manager.networkChanged(value);
    },
    tick(ms) {
      const end = now + ms;
      let iterations = 0;
      while (true) {
        const scheduled = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!scheduled) break;
        assert.ok(++iterations < 1000, 'retry storm');
        const [id, timer] = scheduled;
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = end;
    },
  };
}

test('network events do not log in or create a connection', (t) => {
  const h = harness(t);
  h.online(true);
  h.manager.reconnect();
  assert.equal(h.sockets.length, 0);
});
test('connect is idempotent while connecting and open', (t) => {
  const h = harness(t);
  h.manager.connect();
  h.manager.connect();
  h.sockets[0].open();
  h.manager.connect();
  assert.equal(h.sockets.length, 1);
});
test('disconnect stops pending retries and subsequent online revival', (t) => {
  const h = harness(t);
  h.manager.connect();
  h.sockets[0].onclose({ code: 1006 });
  h.manager.disconnect();
  h.tick(90000);
  h.online(true);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timers.size, 0);
});
for (const code of [1008, 4001])
  test(`auth close ${code} stays disconnected until explicit connect`, (t) => {
    const h = harness(t);
    h.manager.connect();
    h.sockets[0].onclose({ code });
    h.tick(90000);
    h.online(true);
    h.manager.reconnect();
    assert.equal(h.authFailures(), 1);
    assert.equal(h.sockets.length, 1);
    h.manager.connect();
    assert.equal(h.sockets.length, 2);
  });
test('offline closes the radio socket and pauses retries', (t) => {
  const h = harness(t);
  h.manager.connect();
  h.sockets[0].open();
  h.online(false);
  h.tick(90000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].closed, 1);
  h.online(true);
  assert.equal(h.sockets.length, 2);
});
test('online replaces a stale OPEN socket without resending messages', (t) => {
  const h = harness(t);
  h.manager.connect();
  h.sockets[0].open();
  assert.equal(h.manager.send({ type: 'message', content: 'once' }), true);
  h.online(true);
  h.sockets[1].open();
  assert.equal(h.sockets[0].sent.length, 1);
  assert.equal(h.sockets[1].sent.length, 0);
});
test('late callbacks from replaced sockets cannot corrupt current state', (t) => {
  const h = harness(t);
  let count = 0;
  h.manager.on('stream_snapshot', () => count++);
  h.manager.connect();
  const oldMessage = h.sockets[0].onmessage;
  const oldClose = h.sockets[0].onclose;
  h.manager.reconnect();
  h.sockets[1].open();
  oldMessage({ data: '{"type":"stream_snapshot"}' });
  oldClose({ code: 4001 });
  h.sockets[1].message({ type: 'stream_snapshot' });
  assert.equal(count, 1);
  assert.equal(h.authFailures(), 0);
  assert.ok(h.manager.isConnected());
});
test('connecting sockets time out rather than remain stuck forever', (t) => {
  const h = harness(t);
  h.manager.connect();
  h.tick(15000);
  assert.equal(h.sockets[0].closed, 1);
  h.tick(1000);
  assert.equal(h.sockets.length, 2);
});
test('opening a socket clears the connection timeout', (t) => {
  const h = harness(t);
  h.manager.connect();
  h.sockets[0].open();
  h.tick(60000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].closed, 0);
});
test('one failed listener does not block another listener', (t) => {
  const h = harness(t);
  let delivered = 0;
  h.manager.on('stream_snapshot', () => {
    throw new Error('listener');
  });
  h.manager.on('stream_snapshot', () => delivered++);
  h.manager.connect();
  h.sockets[0].message({ type: 'stream_snapshot' });
  assert.equal(delivered, 1);
  assert.equal(h.errors.length, 1);
});
test('unsubscribe is idempotent and malformed frames are ignored', (t) => {
  const h = harness(t);
  let calls = 0;
  const off = h.manager.on('connected', () => calls++);
  off();
  off();
  h.manager.connect();
  h.sockets[0].open();
  h.sockets[0].onmessage({ data: 'not json' });
  assert.equal(calls, 0);
});
test('send failures never replay an uncertain command', (t) => {
  const h = harness(t);
  h.manager.connect();
  h.sockets[0].open();
  h.sockets[0].send = () => {
    throw new Error('socket lost');
  };
  assert.equal(h.manager.send({ type: 'command' }), false);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].sent.length, 0);
});
test('visibility resumes a suspended page, cleanup removes lifecycle listeners', (t) => {
  const h = harness(t);
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.hidden = false;
  let now = 0;
  const cleanup = bindConnectionLifecycle(h.manager, win, doc, () => now);
  h.manager.connect();
  h.sockets[0].open();
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  now = 6000;
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.sockets.length, 2);
  cleanup();
  win.dispatchEvent(new Event('online'));
  assert.equal(h.sockets.length, 2);
});
test('BFCache pageshow reconnects but never revives a logged-out session', (t) => {
  const h = harness(t);
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.hidden = false;
  const cleanup = bindConnectionLifecycle(h.manager, win, doc);
  h.manager.connect();
  h.sockets[0].open();
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  win.dispatchEvent(event);
  assert.equal(h.sockets.length, 2);
  h.manager.disconnect();
  win.dispatchEvent(event);
  assert.equal(h.sockets.length, 2);
  cleanup();
});
test('short visibility switches do not restart healthy sockets', (t) => {
  const h = harness(t);
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.hidden = false;
  let now = 0;
  const cleanup = bindConnectionLifecycle(h.manager, win, doc, () => now);
  h.manager.connect();
  h.sockets[0].open();
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  now = 100;
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.sockets.length, 1);
  cleanup();
});

test('main session has an explicit target rather than device-local defaults', () => {
  assert.equal(sessionRoute('home', null), '/chat/home?session=main');
  assert.ok(isExplicitMainSession({ search: '?session=main', hash: '' }));
  assert.ok(
    isExplicitMainSession({ search: '', hash: '#/app/chat/home?session=main' }),
  );
  assert.equal(
    isExplicitMainSession({ search: '?session=main&agent=other', hash: '' }),
    false,
  );
  assert.equal(
    isExplicitMainSession({ search: '', hash: '#/chat/home' }),
    false,
  );
});
test('sub-session links encode identifiers and preserve deployment base', () => {
  assert.equal(
    sessionLink('https://host.ts.net', '/app/', '资料', 'abc&def'),
    'https://host.ts.net/app/chat/%E8%B5%84%E6%96%99?agent=abc%26def',
  );
  assert.equal(
    sessionLink('https://host.ts.net', '/app/', 'home', null, true),
    'https://host.ts.net/app/#/app/chat/home?session=main',
  );
});
test('empty and dot workspace identifiers are rejected', () => {
  for (const folder of ['', '.', '..'])
    assert.throws(() => sessionRoute(folder, null));
});
test('shared URLs discard credentials, parameters and arbitrary fragments', () => {
  assert.equal(
    sessionLink('https://host.ts.net?token=secret#private', '/', 'home', null),
    'https://host.ts.net/chat/home?session=main',
  );
  assert.throws(() =>
    sessionLink('https://user:secret@host.ts.net', '/', 'home', null),
  );
});
test('remote origin accepts only a clean HTTPS origin', () => {
  assert.equal(
    publicOrigin('https://device.tail.ts.net/'),
    'https://device.tail.ts.net',
  );
  for (const value of [
    'http://example.com',
    'javascript:alert(1)',
    'https://u:p@a.com',
    'https://a.com/path',
    'https://a.com?token=key',
    'https://a.com/#key',
  ])
    assert.throws(() => publicOrigin(value));
});
test('loopback addresses are not advertised as phone links', () => {
  for (const origin of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://0.0.0.0',
  ])
    assert.ok(isLoopbackOrigin(origin));
  assert.equal(isLoopbackOrigin('https://device.tail.ts.net'), false);
});
test('iOS standalone preserves canonical links before router creation', () => {
  assert.equal(
    initialHashRoute(
      { pathname: '/app/chat/home', search: '?agent=a&token=secret', hash: '' },
      '/app/',
    ),
    '/app/#/app/chat/home?agent=a',
  );
  assert.equal(
    initialHashRoute(
      { pathname: '/chat/home', search: '?session=main', hash: '' },
      '/',
    ),
    '/#/chat/home?session=main',
  );
  assert.equal(
    initialHashRoute({ pathname: '/login', search: '', hash: '' }, '/'),
    null,
  );
  assert.equal(
    initialHashRoute(
      { pathname: '/app/chat/home', search: '', hash: '#/existing' },
      '/app/',
    ),
    null,
  );
});

test('Tailscale helper is read-only by default', () => {
  assert.deepEqual(parseOptions([], {}), { port: 3000, serve: false });
  assert.deepEqual(parseOptions(['--serve', '--port', '3456'], {}), {
    port: 3456,
    serve: true,
  });
  assert.deepEqual(parseOptions(['--check'], { WEB_PORT: '4444' }), {
    port: 4444,
    serve: false,
  });
});
test('Tailscale helper rejects ambiguous flags and shell-shaped ports', () => {
  for (const args of [
    ['--funnel'],
    ['--serve', '--check'],
    ['--port'],
    ['--port', '0'],
    ['--port', '65536'],
    ['--port', '3000;echo bad'],
  ])
    assert.throws(() => parseOptions(args, {}));
});
test('Tailscale requires connected state and a valid node name', () => {
  assert.equal(
    tailnetOrigin({
      BackendState: 'Running',
      Self: { DNSName: 'mac.tailnet.ts.net.' },
    }),
    'https://mac.tailnet.ts.net',
  );
  assert.throws(() => tailnetOrigin({ BackendState: 'Stopped' }));
  assert.throws(() =>
    tailnetOrigin({
      BackendState: 'Running',
      Self: { DNSName: 'evil.com/path' },
    }),
  );
});
const origin = 'https://mac.tailnet.ts.net';
const target = 'http://127.0.0.1:3000';
const config = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'mac.tailnet.ts.net:443': { Handlers: { '/': { Proxy: target } } } },
};
test('an already matching Serve route is idempotent', () => {
  assert.equal(checkServeConfig({}, origin, target), false);
  assert.equal(checkServeConfig(config, origin, target), true);
});
test('Serve never overwrites another target or a TCP listener', () => {
  assert.throws(() =>
    checkServeConfig(config, origin, 'http://127.0.0.1:9999'),
  );
  assert.throws(() =>
    checkServeConfig(
      { TCP: { 443: { TCPForward: 'localhost:22' } } },
      origin,
      target,
    ),
  );
});
test('Serve refuses public Funnel and shared HTTPS listeners', () => {
  assert.throws(() =>
    checkServeConfig(
      { AllowFunnel: { 'mac.tailnet.ts.net:443': true } },
      origin,
      target,
    ),
  );
  assert.throws(() =>
    checkServeConfig(
      {
        Web: {
          'mac.tailnet.ts.net:443': {
            Handlers: { '/other': { Proxy: target } },
          },
        },
      },
      origin,
      target,
    ),
  );
  assert.throws(() => checkServeConfig(null, origin, target));
});

function workerHarness(clients = []) {
  const handlers = new Map();
  const opened = [];
  const focused = [];
  const source = fs.readFileSync(
    path.join(root, 'web/public/pocket-notifications/sw.js'),
    'utf8',
  );
  vm.runInNewContext(source, {
    URL,
    self: {
      addEventListener: (kind, handler) => handlers.set(kind, handler),
      skipWaiting: () => {},
      registration: { scope: 'https://host.test/app/pocket-notifications/' },
      clients: {
        claim: async () => {},
        matchAll: async () =>
          clients.map((url) => ({ url, focus: async () => focused.push(url) })),
        openWindow: async (url) => opened.push(url),
      },
    },
  });
  return { handlers, opened, focused };
}
test('notification worker cannot cache or intercept application requests', () => {
  const h = workerHarness();
  assert.equal(h.handlers.has('fetch'), false);
  assert.equal(
    h.handlers.has('push'),
    false,
    'server Web Push is deliberately not advertised',
  );
});
test('notification clicks ignore attacker-controlled navigation URLs', async () => {
  const h = workerHarness([
    'https://host.test/other-app/',
    'https://evil.test/app/',
  ]);
  let work;
  h.handlers.get('notificationclick')({
    notification: { data: { url: 'https://evil.test' }, close() {} },
    waitUntil(value) {
      work = value;
    },
  });
  await work;
  assert.deepEqual(h.opened, ['https://host.test/app/chat']);
  assert.deepEqual(h.focused, []);
});
test('notification click focuses an existing application window', async () => {
  const h = workerHarness(['https://host.test/app/chat/home']);
  let work;
  h.handlers.get('notificationclick')({
    notification: { close() {} },
    waitUntil(value) {
      work = value;
    },
  });
  await work;
  assert.equal(h.opened.length, 0);
  assert.equal(h.focused.length, 1);
});
test('integration keeps legacy worker retirement and the original queue', () => {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const main = read('web/src/main.tsx');
  const layout = read('web/src/components/layout/AppLayout.tsx');
  const panel = read('web/src/features/pocket/PocketPanel.tsx');
  assert.match(main, /cleanupLegacyPwaArtifacts/);
  assert.doesNotMatch(main, /serviceWorker\.register|registerSW/);
  assert.match(layout, /<PocketPanel\s*\/>/);
  assert.match(layout, /return \(\) => wsManager\.disconnect\(\)/);
  assert.match(panel, /sendAgentMessage/);
  assert.match(panel, /state\.sendMessage/);
  assert.doesNotMatch(panel, /\.abort\(|\.stopGroup\(|\.interruptQuery\(/);
});

async function notificationHarness(options = {}) {
  const shown = [];
  const registrations = [];
  const constructors = [];
  let requests = 0;
  const values = new Map(
    options.saved === undefined
      ? []
      : [['miniclaw:pocket:notifications', options.saved]],
  );
  const reg = {
    active: {},
    getNotifications: async () => [],
    showNotification: async (title, payload) => shown.push({ title, payload }),
  };
  const events = new Map();
  class Notice {
    static permission = options.permission ?? 'granted';
    static async requestPermission() {
      requests++;
      return Notice.permission;
    }
    constructor(title, payload) {
      if (options.constructorFails) throw new Error('mobile constructor');
      constructors.push({ title, payload });
    }
  }
  const context = vm.createContext({
    URL,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    Notification: Notice,
    location: { origin: 'https://host.test' },
    document: { hidden: options.hidden ?? true },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    window: {
      isSecureContext: true,
      focus() {},
      addEventListener: (event, listener) => events.set(event, listener),
      removeEventListener() {},
    },
    navigator: {
      serviceWorker: {
        async register(url, config) {
          registrations.push({ url, config });
          if (options.registrationFails)
            throw new Error('registration blocked');
          return reg;
        },
      },
    },
  });
  const source = fs.readFileSync(
    path.join(root, 'web/src/features/pocket/notifications.ts'),
    'utf8',
  );
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = new vm.SourceTextModule(js, {
    context,
    initializeImportMeta(meta) {
      meta.hot = undefined;
    },
  });
  const urls = new vm.SourceTextModule(
    "export const APP_BASE = '/app/'; export const withBasePath = (path) => '/app' + path;",
    { context },
  );
  const brand = new vm.SourceTextModule(
    "export const appNotificationIconUrl = '/app/icons/icon-192.png?v=robot';",
    { context },
  );
  await module.link((specifier) => {
    if (specifier === '../../utils/url') return urls;
    if (specifier === '../../utils/brand') return brand;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  return {
    api: module.namespace,
    shown,
    registrations,
    constructors,
    requests: () => requests,
    events,
    Notice,
    reg,
  };
}
test('notification setup never prompts on a passive event', async () => {
  const h = await notificationHarness({ permission: 'default' });
  await h.api.notifyPocketIfHidden();
  assert.equal(h.requests(), 0);
  assert.equal(h.registrations.length, 0);
});
test('mobile notifications use a child-scope worker and no lock-screen content', async () => {
  const h = await notificationHarness();
  await h.api.notifyPocketIfHidden();
  assert.equal(h.shown.length, 1);
  assert.equal(h.constructors.length, 0);
  assert.equal(
    h.registrations[0].config.scope,
    'https://host.test/app/pocket-notifications/',
  );
  assert.equal(h.registrations[0].config.updateViaCache, 'none');
  assert.equal(h.shown[0].payload.data.url, 'https://host.test/app/chat');
  assert.equal(h.shown[0].payload.icon, '/app/icons/icon-192.png?v=robot');
  assert.equal(h.shown[0].payload.body, '有新的会话结果，打开 Miniclaw 查看。');
});
test('explicit opt-out overrides a previously granted browser permission', async () => {
  const h = await notificationHarness({ saved: 'disabled' });
  await h.api.notifyPocketIfHidden(true);
  assert.equal(h.shown.length, 0);
});
test('visible pages are quiet unless a user requests a test notification', async () => {
  const h = await notificationHarness({ hidden: false });
  await h.api.notifyPocketIfHidden();
  assert.equal(h.shown.length, 0);
  await h.api.notifyPocketIfHidden(true);
  assert.equal(h.shown.length, 1);
});
test('registration and unsupported constructor failures cannot break chat', async () => {
  const h = await notificationHarness({
    registrationFails: true,
    constructorFails: true,
  });
  await assert.doesNotReject(h.api.notifyPocketIfHidden());
});
test('notification permission is requested only through explicit enable', async () => {
  const h = await notificationHarness();
  assert.equal(await h.api.enablePocketNotifications(), 'granted');
  assert.equal(h.requests(), 1);
  assert.equal(h.api.notificationsEnabled(), true);
  h.api.setNotificationsEnabled(false);
  await h.api.notifyPocketIfHidden(true);
  assert.equal(h.shown.length, 0);
});
test('cross-tab opt-out prevents the other tab from continuing to notify', async () => {
  const h = await notificationHarness();
  h.events.get('storage')({
    key: 'miniclaw:pocket:notifications',
    newValue: 'disabled',
  });
  await h.api.notifyPocketIfHidden(true);
  assert.equal(h.shown.length, 0);
});
test('browser denial is recorded as an opt-out', async () => {
  const h = await notificationHarness({ permission: 'denied' });
  assert.equal(await h.api.enablePocketNotifications(), 'denied');
  assert.equal(h.api.notificationsEnabled(), false);
  assert.equal(h.registrations.length, 0);
});
