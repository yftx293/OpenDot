import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const testRoot = fs.mkdtempSync(
  path.join(
    process.env.MINICLAW_CONTAINER_TEST_ROOT ?? os.tmpdir(),
    'miniclaw-container-permissions-',
  ),
);

afterAll(() => fs.rmSync(testRoot, { recursive: true, force: true }));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: path.join(testRoot, 'data'),
    GROUPS_DIR: path.join(testRoot, 'data', 'groups'),
    STORE_DIR: path.join(testRoot, 'data', 'db'),
    CONTAINER_IMAGE: 'miniclaw-agent:test',
    TIMEZONE: 'UTC',
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

const {
  buildContainerArgs,
  detectContainerHostIdentity,
  resolveContainerHostIdentity,
} = await import('../src/container-runner.js');

const mounts = [
  {
    hostPath: '/host/session',
    containerPath: '/home/node/.claude',
    readonly: false,
  },
];

function envArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-e') values.push(args[index + 1]);
  }
  return values;
}

describe('container host identity resolution', () => {
  test('uses direct ids only for rootful Linux without a user namespace', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1234,
        securityOptions: ['name=seccomp,profile=builtin'],
      }),
    ).toEqual({ mode: 'direct', uid: 1002, gid: 1234 });
  });

  test('distinguishes rootless from rootful userns-remap', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: ['name=rootless'],
      }),
    ).toEqual({ mode: 'rootless' });
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: ['name=userns'],
      }),
    ).toEqual({ mode: 'userns' });
  });

  test('does not hide a rootless daemon behind a host-root client uid', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 0,
        gid: 0,
        securityOptions: ['name=rootless'],
      }),
    ).toEqual({ mode: 'rootless' });
  });

  test('keeps host-root non-root inside the container', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 0,
        gid: 0,
        securityOptions: [],
      }),
    ).toEqual({ mode: 'host-root' });
  });

  test.each(['darwin', 'win32'] as const)(
    'preserves Docker Desktop virtualized semantics on %s',
    (platform) => {
      expect(
        resolveContainerHostIdentity({
          platform,
          uid: 501,
          gid: 20,
          securityOptions: [],
        }),
      ).toEqual({ mode: 'virtualized' });
    },
  );

  test('fails closed when daemon security options cannot be detected', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: null,
      }),
    ).toEqual({ mode: 'unknown' });
  });

  test('re-probes daemon security options for every launch', () => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) return;
    expect(detectContainerHostIdentity(() => [])).toMatchObject({
      mode: 'direct',
    });
    expect(detectContainerHostIdentity(() => ['name=userns'])).toEqual({
      mode: 'userns',
    });
    expect(detectContainerHostIdentity(() => ['name=rootless'])).toEqual({
      mode: 'rootless',
    });
    expect(detectContainerHostIdentity(() => null)).toEqual({
      mode: 'unknown',
    });
    expect(detectContainerHostIdentity(() => [])).toMatchObject({
      mode: 'direct',
    });
  });
});

describe('buildContainerArgs identity contract', () => {
  test('passes independently validated non-root uid and gid in direct mode', () => {
    const args = buildContainerArgs(mounts, 'identity-test', 'UTC', {
      mode: 'direct',
      uid: 1002,
      gid: 1234,
    });
    expect(envArgs(args)).toEqual(
      expect.arrayContaining([
        'MINICLAW_HOST_IDENTITY_MODE=direct',
        'MINICLAW_HOST_UID=1002',
        'MINICLAW_HOST_GID=1234',
      ]),
    );
  });

  test.each([
    'rootless',
    'userns',
    'virtualized',
    'host-root',
    'unknown',
  ] as const)('never forwards numeric host ids in %s mode', (mode) => {
    const args = buildContainerArgs(mounts, 'identity-test', 'UTC', {
      mode,
      uid: 1002,
      gid: 1002,
    });
    expect(envArgs(args)).toContain(`MINICLAW_HOST_IDENTITY_MODE=${mode}`);
    expect(
      envArgs(args).some((arg) => arg.startsWith('MINICLAW_HOST_UID=')),
    ).toBe(false);
    expect(
      envArgs(args).some((arg) => arg.startsWith('MINICLAW_HOST_GID=')),
    ).toBe(false);
  });
});

// Opt-in: exercise Docker's actual bind parser and daemon behavior using a
// local image and a disposable host directory, without network access.
const bindImage = process.env.MINICLAW_DOCKER_BIND_TEST_IMAGE;
describe.skipIf(!bindImage)('actual Docker bind mounts', () => {
  test('binds quoted paths read-only and rejects a missing source', () => {
    const temp = fs.realpathSync(
      fs.mkdtempSync(
        path.join(
          process.env.MINICLAW_DOCKER_BIND_TEST_ROOT ?? os.tmpdir(),
          'opendot-bind-',
        ),
      ),
    );
    const source = path.join(temp, 'source,with"quote');
    const dest = '/mnt/scope,with"quote';
    fs.mkdirSync(source);
    fs.mkdirSync(path.join(source, 'sentinel'));
    const mountOption = (hostPath: string) => {
      const args = buildContainerArgs(
        [{ hostPath, containerPath: dest, readonly: true }],
        'bind-test',
        'UTC',
        { mode: 'virtualized' },
      );
      const index = args.indexOf('--mount');
      expect(index).toBeGreaterThan(-1);
      return args[index + 1]!;
    };
    try {
      const run = (option: string, program: string) =>
        spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--mount',
            option,
            '--entrypoint',
            'node',
            bindImage!,
            '-e',
            program,
          ],
          { encoding: 'utf8', timeout: 30000 },
        );
      const probe = run(
        mountOption(source),
        `const fs=require('fs');const p=${JSON.stringify(dest)};if(!fs.existsSync(p+'/sentinel'))process.exit(2);try{fs.mkdirSync(p+'/unexpected');process.exit(3)}catch(e){if(e.code!=='EROFS')process.exit(4)}`,
      );
      expect(probe.status, probe.stderr).toBe(0);
      expect(fs.existsSync(path.join(source, 'unexpected'))).toBe(false);
      const missing = path.join(temp, 'missing');
      const denied = run(mountOption(missing), 'process.exit(0)');
      expect(denied.status, denied.stderr).not.toBe(0);
      expect(denied.stderr).toMatch(/bind source path does not exist/i);
      expect(fs.existsSync(missing)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 60000);
});

describe('entrypoint permission contract', () => {
  const dockerfile = fs.readFileSync(
    path.join(repoRoot, 'container', 'Dockerfile'),
    'utf8',
  );
  const entrypoint = fs.readFileSync(
    path.join(repoRoot, 'container', 'entrypoint.sh'),
    'utf8',
  );
  const helper = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions.sh'),
    'utf8',
  );
  const watcher = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions-watcher.mjs'),
    'utf8',
  );
  const mountBoundaryPath = path.join(
    repoRoot,
    'container',
    'session-permissions-mount.mjs',
  );
  const mountBoundary = fs.readFileSync(mountBoundaryPath, 'utf8');
  const fileManager = fs.readFileSync(
    path.join(repoRoot, 'src', 'file-manager.ts'),
    'utf8',
  );
  const groupQueue = fs.readFileSync(
    path.join(repoRoot, 'src', 'group-queue.ts'),
    'utf8',
  );

  test('uses fixed root-owned helpers and shadows stale malicious env values', () => {
    expect(entrypoint).toContain('source /app/session-permissions.sh');
    expect(entrypoint).toContain('miniclaw_source_runtime_env');
    expect(helper).toContain(
      '/usr/local/bin/node /app/session-permissions-watcher.mjs',
    );
    expect(helper).not.toContain('MINICLAW_SESSION_PERMISSION_HELPER:-');
    expect(helper).not.toContain('groupmod --non-unique');
    expect(helper).toContain('local MINICLAW_SESSION_ROOT=');
    expect(helper).toContain('local MINICLAW_INTERNAL_WATCHER_PID=');
    expect(entrypoint).toContain(
      'npx tsc --outDir /tmp/dist --incremental false',
    );
    expect(
      entrypoint.indexOf('miniclaw_prepare_generated_path dist'),
    ).toBeLessThan(
      entrypoint.indexOf('ln -s /app/node_modules /tmp/dist/node_modules'),
    );
    expect(entrypoint).toContain('/app/session-prompts-copy.mjs');
    expect(entrypoint).not.toContain('ln -s /app/prompts /tmp/prompts');
    expect(entrypoint).toContain(
      'runuser -u node -- env HOME=/home/node /usr/bin/git',
    );
    expect(dockerfile).toContain('chown -R root:root /app/prompts');
    expect(dockerfile).toContain('find /app/prompts -type d -exec chmod 0555');
    expect(dockerfile).toContain('find /app/prompts -type f -exec chmod 0444');
  });

  test('contains no world-permission fallback', () => {
    expect(entrypoint).not.toMatch(/umask\s+0000/);
    expect(entrypoint).not.toMatch(/chmod[^\n]*a\+(?:rw|rwx|rwX)/);
    expect(helper).not.toMatch(/chmod[^\n]*a\+(?:rw|rwx|rwX)/);
    expect(helper).not.toMatch(/0?666|0?777/);
    expect(watcher).toContain('0o660');
    expect(watcher).toContain('0o2770');
    expect(watcher).not.toMatch(/fchmodSync\([^,\n]+,\s*0o(?:666|777)\b/);
    expect(fileManager).not.toContain('0o777');
    expect(groupQueue).not.toContain('0o777');
    expect(entrypoint).not.toMatch(/(?:chown|chmod)\s+-R/);
    expect(helper).not.toMatch(/(?:chown|chmod)\s+-R/);
  });

  test('watcher has fixed roots, descriptor-safe paths and bounded rescans', () => {
    expect(watcher).toContain("path: '/home/node/.claude'");
    expect(watcher).toContain("path: '/home/node/.feishu-cli'");
    expect(watcher).toContain("encoding: 'buffer'");
    expect(watcher).toContain('fs.constants.O_NOFOLLOW');
    expect(watcher).toContain('/proc/self/fd/');
    expect(watcher).toContain('readDescriptorMountId(root.fd)');
    expect(watcher).toContain('mountId !== root.mountId');
    expect(watcher).toContain('stat.nlink > 1');
    expect(watcher).toContain('reconcileDescriptorOwnership(');
    expect(mountBoundary).toContain('io.fchownSync(fd');
    expect(watcher).toContain('fs.fchmodSync(fd');
    expect(watcher).not.toMatch(/fs\.(?:chown|chmod)Sync\(/);
    expect(watcher).not.toContain('lstatSync');
    expect(watcher).toContain('RESCAN_INTERVAL_MS = 30_000');
    expect(watcher).not.toContain('RESCAN_INTERVAL_MS = 500');
    expect(mountBoundary).not.toMatch(/catch\s*\{/);
  });

  test('virtualized ownership converges without losing mode or inode isolation', () => {
    const moduleUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { reconcileDescriptorOwnership as apply } from ${JSON.stringify(moduleUrl)};
      const stat = { dev: 1, ino: 10, uid: 0, gid: 0 };
      let changes = 0;
      const io = { fchownSync() { changes++; }, fstatSync() { return stat; } };
      const root = { virtualizedOwnership: new Map() };
      assert.equal(apply(3, stat, 1000, 1000, root, io), true);
      // Repeated self-generated watch events must not rewrite metadata.
      for (let i = 0; i < 100; i++) assert.equal(apply(3, stat, 1000, 1000, root, io), false);
      assert.equal(changes, 1);
      // Large mounts must not churn evicted entries into new watch events.
      for (let ino = 20; ino < 5020; ino++) apply(4, { ...stat, ino }, 1000, 1000, root, io);
      assert.equal(apply(3, stat, 1000, 1000, root, io), false);
      assert.equal(apply(4, { ...stat, ino: 11 }, 1000, 1000, root, io), true);
      assert.equal(apply(3, { ...stat, uid: 12 }, 1000, 1000, root, io), true);
      // Numeric identity modes never accept host-mapped ownership.
      assert.equal(apply(3, stat, 1000, 1000, {}, io), true);
      assert.equal(apply(3, stat, 1000, 1000, {}, io), true);
      const failed = { virtualizedOwnership: new Map() };
      assert.throws(() => apply(3, stat, 1000, 1000, failed, { fchownSync() { throw Error('denied'); } }));
      assert.equal(failed.virtualizedOwnership.size, 0);
      assert.equal(apply(3, { ...stat, uid: 1000, gid: 1000 }, 1000, 1000, root, io), false);
    `,
    ]);
  });

  test('new entry events invalidate virtualized inode ownership cache', () => {
    const reconcileUrl = pathToFileURL(
      path.join(repoRoot, 'container/native/session-watch-reconcile.mjs'),
    ).href;
    const mountUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { reconcileWatchEvents } from ${JSON.stringify(reconcileUrl)};
      import { preciseDescriptorIdentity } from ${JSON.stringify(mountUrl)};
      const dir = fs.mkdtempSync(path.join(${JSON.stringify(testRoot)}, 'watch-cache-'));
      const file = path.join(dir, 'entry');
      fs.writeFileSync(file, 'fixture');
      const rootFd = fs.openSync(dir, 'r');
      const fileFd = fs.openSync(file, 'r');
      const rootIdentity = preciseDescriptorIdentity(rootFd, fs.fstatSync(rootFd));
      const fileIdentity = preciseDescriptorIdentity(fileFd, fs.fstatSync(fileFd));
      fs.closeSync(fileFd);
      const key = [fileIdentity.device, fileIdentity.inode, 1000, 1000].join(':');
      const cache = new Map([[key, 'old-mapped-owner']]);
      const root = { active: true, fd: rootFd, uid: 1000, gid: 1000, path: dir, virtualizedOwnership: cache };
      const watches = new Map([[1, { root, components: [], ...rootIdentity }]]);
      const native = { openChildAsNode: () => fs.openSync(file, 'r') };
      const observed = [];
      const normalize = (fd) => {
        if (fd !== rootFd) observed.push(cache.has(key));
        return { stat: fs.fstatSync(fd), outsideRootMount: false };
      };
      const event = (mask) => ({ wd: 1, name: Buffer.from('entry'), mask, directory: false, coverageLost: false });
      try {
        reconcileWatchEvents(native, watches, [event(0x100)], normalize);
        assert.deepEqual(observed, [false]);
        cache.set(key, 'current-mapped-owner');
        reconcileWatchEvents(native, watches, [event(0x4)], normalize);
        assert.deepEqual(observed, [false, true]);
        reconcileWatchEvents(native, watches, [event(0x80)], normalize);
        assert.deepEqual(observed, [false, true, false]);
      } finally {
        fs.closeSync(rootFd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      `,
    ]);
  });

  test('preserves descriptor identities beyond JavaScript safe integers', () => {
    const moduleUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { preciseDescriptorIdentity as identity } from ${JSON.stringify(moduleUrl)};
      const rounded = { dev: 1, ino: 9007199254740992 };
      const first = identity(3, rounded, { fstatSync: () => ({ dev: 1n, ino: 9007199254740992n }) });
      const second = identity(4, rounded, { fstatSync: () => ({ dev: 1n, ino: 9007199254740993n }) });
      assert.notEqual(first.inode, second.inode);
      assert.throws(() => identity(3, rounded, { fstatSync: () => rounded }));
      `,
    ]);
  });

  test('validates both raw and Linux recursive-watch filename events', () => {
    const moduleUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { watchRelativeComponents as parse } from ${JSON.stringify(moduleUrl)};
      assert.deepEqual(parse('agent/auth.json').map(x => x.toString()), ['agent', 'auth.json']);
      assert.deepEqual(parse('目录/file').map(x => x.toString()), ['目录', 'file']);
      assert.deepEqual(parse(Buffer.from([0xff, 0x2f, 0x61])), [Buffer.from([0xff]), Buffer.from('a')]);
      for (const value of ['', '/etc/passwd', 'a/../b', 'a//b', 'a/./b', 'a/\\0b', 'a/\\ufffd', 'a/\\ud800', null]) {
        assert.equal(parse(value), null);
      }
      `,
    ]);
  });

  test('deferred rescans distinguish root and binary path component boundaries', () => {
    const moduleUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { watchRescanKey as key } from ${JSON.stringify(moduleUrl)};
      const parts = (...values) => values.map(value => Buffer.from(value));
      assert.notEqual(key('/root', parts('a', 'bc')), key('/root', parts('ab', 'c')));
      assert.notEqual(key('/root', parts('a')), key('/root-other', parts('a')));
      assert.notEqual(key('/root', [Buffer.from([0xff])]), key('/root', [Buffer.from([0xfe])]));
      assert.equal(key('/root', parts('same', 'path')), key('/root', parts('same', 'path')));
      `,
    ]);
  });

  test('repeated successful watch re-registrations still exhaust a bounded loss window', () => {
    const moduleUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import { recordWatchRecovery } from ${JSON.stringify(moduleUrl)};
      let history = [];
      for (let n = 0; n < 7; n++) {
        const result = recordWatchRecovery(history, n * 100, 10000, 8);
        assert.equal(result.exhausted, false);
        history = result.recent;
      }
      assert.equal(recordWatchRecovery(history, 700, 10000, 8).exhausted, true);
      const expired = recordWatchRecovery(history, 11000, 10000, 8);
      assert.deepEqual(expired.recent, [11000]);
      assert.equal(expired.exhausted, false);
      `,
    ]);
  });

  test('mount metadata parser fails closed without a unique valid mnt_id', () => {
    const moduleUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import {
          parseDescriptorMountId,
          readDescriptorMountId,
        } from ${JSON.stringify(moduleUrl)};
        assert.equal(parseDescriptorMountId('pos:\\t0\\nmnt_id:\\t1725\\n'), 1725);
        assert.throws(() => parseDescriptorMountId('pos:\\t0\\n'));
        assert.throws(() => parseDescriptorMountId('mnt_id:\\t1\\nmnt_id:\\t2\\n'));
        assert.throws(() => parseDescriptorMountId('mnt_id:\\tinvalid\\n'));
        assert.throws(() => readDescriptorMountId(99, () => {
          throw new Error('fdinfo unavailable');
        }));
      `,
    ]);
  });
});

const integrationImage =
  process.env.MINICLAW_CONTAINER_PERMISSION_TEST_IMAGE ??
  'helsome/miniclaw-agent:latest';
let integrationImageAvailable = false;
try {
  execFileSync('docker', ['image', 'inspect', integrationImage], {
    stdio: 'ignore',
  });
  integrationImageAvailable = true;
} catch {
  // Unit and contract tests remain hermetic when Docker is unavailable.
}

describe.skipIf(!integrationImageAvailable)(
  'permission helper behavior in the branch image',
  () => {
    // Supply helper sources over Docker stdin so the daemon reads plaintext
    // even when host bind mounts expose a transparent-encryption envelope.
    const nativeSources = [
      'native/session-watch-identity.c',
      'native/session-watch-events.mjs',
      'native/session-watch-reader.mjs',
      'native/session-watch-pump.mjs',
      'native/session-watch-tree.mjs',
      'native/session-watch-reopen.mjs',
      'native/session-watch-reconcile.mjs',
      'native/session-watch-pending.mjs',
      'native/session-watch-supervisor.mjs',
    ];
    const helperSources = [
      'session-permissions.sh',
      'session-permissions-watcher.mjs',
      'session-permissions-mount.mjs',
      'session-prompts-copy.mjs',
      ...nativeSources,
    ].map((name) =>
      fs
        .readFileSync(path.join(repoRoot, 'container', name))
        .toString('base64'),
    );
    const helperBootstrap = [
      'IFS= read -r helper; printf %s "$helper" | base64 -d > /tmp/session-permissions.sh',
      'IFS= read -r helper; printf %s "$helper" | base64 -d > /app/session-permissions-watcher.mjs',
      'IFS= read -r helper; printf %s "$helper" | base64 -d > /app/session-permissions-mount.mjs',
      'IFS= read -r helper; printf %s "$helper" | base64 -d > /app/session-prompts-copy.mjs',
      'mkdir -p /app/native',
      ...nativeSources.map(
        (name) =>
          `IFS= read -r helper; printf %s "$helper" | base64 -d > /app/${name}`,
      ),
      'cc -shared -fPIC -O2 -std=c11 -I/usr/local/include/node -DNODE_GYP_MODULE_NAME=session_watch_identity -o /app/native/session-watch-identity.node /app/native/session-watch-identity.c -lm',
    ].join('\n');

    function runImageScript(script: string, extraArgs: string[] = []): string {
      return execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/bash',
          ...extraArgs,
          integrationImage,
          '-ceu',
          script,
        ],
        { encoding: 'utf8' },
      ).trim();
    }

    function runHelper(script: string, extraArgs: string[] = []): string {
      return execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '--entrypoint',
          '/bin/bash',
          ...extraArgs,
          integrationImage,
          '-ceu',
          `${helperBootstrap}\nsource /tmp/session-permissions.sh\n${script}`,
        ],
        { encoding: 'utf8', input: helperSources.join('\n') + '\n' },
      ).trim();
    }

    function fileSnapshot(filePath: string) {
      const stat = fs.statSync(filePath);
      return {
        uid: stat.uid,
        gid: stat.gid,
        mode: stat.mode & 0o7777,
        nlink: stat.nlink,
        content: fs.readFileSync(filePath, 'utf8'),
      };
    }

    test('direct mode safely falls back from an image group gid collision', () => {
      expect(
        runHelper(`
          shadow_gid=$(getent group shadow | cut -d: -f3)
          original_gid=$(id -g node)
          test -n "$shadow_gid"
          MINICLAW_HOST_IDENTITY_MODE=direct
          MINICLAW_HOST_UID=12346
          MINICLAW_HOST_GID="$shadow_gid"
          miniclaw_configure_node_identity
          install -o 12346 -g "$shadow_gid" -m 0600 /dev/null /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" --clear-groups -- \
            test -r /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" --clear-groups -- \
            test ! -r /etc/shadow
          test "$(id -u node)" = 12346
          test "$(id -g node)" = "$original_gid"
          printf uid-aligned
        `),
      ).toBe('uid-aligned');
    });

    test('exact image aligns uid without granting the shadow group', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          shadow_gid=$(getent group shadow | cut -d: -f3)
          original_gid=$(id -g node)
          MINICLAW_HOST_IDENTITY_MODE=direct
          MINICLAW_HOST_UID=12346
          MINICLAW_HOST_GID="$shadow_gid"
          miniclaw_configure_node_identity
          test "$(id -u node)" = 12346
          test "$(id -g node)" = "$original_gid"
          install -o 12346 -g "$shadow_gid" -m 0600 /dev/null /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" \
            --clear-groups -- test -r /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" \
            --clear-groups -- test ! -r /etc/shadow
          printf 'uid-aligned:shadow-unreadable'
        `),
      ).toBe('uid-aligned:shadow-unreadable');
    });

    test('fails closed for rootful userns-remap and unknown probes', () => {
      for (const mode of ['userns', 'unknown']) {
        expect(() =>
          runHelper(`
            MINICLAW_HOST_IDENTITY_MODE=${mode}
            miniclaw_configure_node_identity
          `),
        ).toThrow();
      }
    });

    test('rootless watcher upgrades legacy node-owned roots before readiness', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /home/node/.feishu-cli \
            /workspace/{group,ipc,extra}
          for root in /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra; do
            touch "$root/legacy-file"
            chown -R 1000:1000 "$root"
            chmod 0700 "$root"
            chmod 0600 "$root/legacy-file"
          done
          MINICLAW_HOST_IDENTITY_MODE=rootless
          miniclaw_configure_node_identity
          miniclaw_start_session_permission_watcher
          for root in /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra; do
            test "$(stat -c '%u:%g:%a' "$root")" = '0:1000:2770'
            test "$(stat -c '%u:%g:%a' "$root/legacy-file")" = \
              '0:1000:660'
          done
          miniclaw_stop_session_permission_watcher
          printf upgraded-before-ready
        `),
      ).toBe('upgraded-before-ready');
    });

    test('rootless watcher accepts mixed mapped and legacy roots including Feishu state', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /home/node/.feishu-cli \
            /workspace/{group,ipc,extra}
          chown 0:1000 /home/node/.claude /workspace/ipc
          chown 1000:1000 /home/node/.feishu-cli /workspace/group /workspace/extra
          chmod 0700 /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra
          MINICLAW_HOST_IDENTITY_MODE=rootless
          miniclaw_configure_node_identity
          miniclaw_start_session_permission_watcher
          for root in /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra; do
            test "$(stat -c '%u:%g:%a' "$root")" = '0:1000:2770'
          done
          miniclaw_stop_session_permission_watcher
          printf mixed-upgraded
        `),
      ).toBe('mixed-upgraded');
    });

    test('rootless verifier still rejects arbitrary bind-root ownership', () => {
      expect(() =>
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          chown 1234:1234 /workspace/group
          MINICLAW_HOST_IDENTITY_MODE=rootless
          miniclaw_configure_node_identity
          miniclaw_start_session_permission_watcher
        `),
      ).toThrow();
    });

    test('direct migration changes only legacy uid 1000 in fixed managed roots', () => {
      expect(
        runHelper(`
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          touch /home/node/.claude/token.json /workspace/group/canary
          chown -R 1000:1000 /home/node/.claude /workspace/group
          chmod 0777 /home/node/.claude
          chmod 0666 /home/node/.claude/token.json
          MINICLAW_HOST_IDENTITY_MODE=direct
          MINICLAW_HOST_UID=12346
          MINICLAW_HOST_GID=12347
          miniclaw_configure_node_identity
          miniclaw_migrate_direct_managed_paths
          printf '%s|%s|%s' \
            "$(stat -c '%u:%g:%a' /home/node/.claude/token.json)" \
            "$(stat -c '%u:%g' /workspace/group/canary)" \
            "$(find /home/node/.claude -maxdepth 1 -name '.miniclaw-owner-v2-*' | wc -l)"
        `),
      ).toBe('12346:12347:600|1000:1000|0');
    });

    test('fake legacy migration marker cannot preserve unsafe credentials', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          touch /home/node/.claude/.miniclaw-owner-v2-12346-12347
          touch /home/node/.claude/credential
          chown -R 1000:1000 /home/node/.claude
          chmod 0600 /home/node/.claude/.miniclaw-owner-v2-12346-12347
          chmod 0666 /home/node/.claude/credential
          MINICLAW_HOST_IDENTITY_MODE=direct
          MINICLAW_HOST_UID=12346
          MINICLAW_HOST_GID=12347
          miniclaw_configure_node_identity
          miniclaw_migrate_direct_managed_paths
          stat -c '%u:%g:%a' /home/node/.claude/credential
        `),
      ).toBe('12346:12347:600');
    });

    test('concurrent direct migrations are idempotent without markers', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /home/node/.feishu-cli \
            /workspace/{group,ipc,extra}
          node -e "const fs=require('fs'); for(let i=0;i<2000;i++) fs.writeFileSync('/home/node/.feishu-cli/f'+i,'',{mode:0o666})"
          chown -R 1000:1000 /home/node/.claude /home/node/.feishu-cli
          MINICLAW_HOST_IDENTITY_MODE=direct
          MINICLAW_HOST_UID=12346
          MINICLAW_HOST_GID=12347
          miniclaw_configure_node_identity
          for round in $(seq 1 5); do
            node /app/session-permissions-watcher.mjs --migrate-direct &
            first=$!
            node /app/session-permissions-watcher.mjs --migrate-direct &
            second=$!
            wait "$first"
            wait "$second"
          done
          test "$(find /home/node/.feishu-cli -name '.miniclaw-owner-v2-*' | wc -l)" = 0
          stat -c '%u:%g:%a' /home/node/.feishu-cli/f1
        `),
      ).toBe('12346:12347:600');
    }, 30_000);

    test('direct cleanup tightens files changed during the container run', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          MINICLAW_HOST_IDENTITY_MODE=direct
          MINICLAW_HOST_UID=12346
          MINICLAW_HOST_GID=12347
          miniclaw_configure_node_identity
          miniclaw_migrate_direct_managed_paths
          install -o 12346 -g 12347 -m 0666 /dev/null \
            /home/node/.claude/runtime-created
          miniclaw_stop_session_permission_watcher
          stat -c '%u:%g:%a' /home/node/.claude/runtime-created
        `),
      ).toBe('12346:12347:600');
    });

    test.each(['rw', 'ro'] as const)(
      'exact image skips a same-filesystem %s nested bind',
      (access) => {
        const outer = fs.mkdtempSync(path.join(testRoot, 'nested-outer-'));
        const outside = fs.mkdtempSync(path.join(testRoot, 'nested-outside-'));
        fs.mkdirSync(path.join(outer, 'nested'));
        const canary = path.join(outside, 'canary');
        fs.writeFileSync(canary, 'nested-bind-canary', { mode: 0o640 });
        fs.chmodSync(canary, 0o640);
        expect(fs.statSync(outer).dev).toBe(fs.statSync(outside).dev);
        const before = fileSnapshot(canary);

        expect(
          runImageScript(
            `
              mkdir -p /workspace/{group,ipc,extra}
              node /app/session-permissions-watcher.mjs \
                --normalize-node-owned-mounts
              printf safe
            `,
            [
              '-v',
              `${outer}:/home/node/.claude`,
              '-v',
              `${outside}:/home/node/.claude/nested${
                access === 'ro' ? ':ro' : ''
              }`,
            ],
          ),
        ).toBe('safe');
        expect(fileSnapshot(canary)).toEqual(before);
      },
    );

    test('managed hardlinks fail closed without changing the outside inode', () => {
      const session = fs.mkdtempSync(path.join(testRoot, 'hardlink-session-'));
      const outside = fs.mkdtempSync(path.join(testRoot, 'hardlink-outside-'));
      const canary = path.join(outside, 'canary');
      const inside = path.join(session, 'inside-link');
      fs.writeFileSync(canary, 'hardlink-canary', { mode: 0o640 });
      fs.chmodSync(canary, 0o640);
      fs.linkSync(canary, inside);
      const before = fileSnapshot(canary);

      expect(() =>
        runImageScript(
          `
            mkdir -p /workspace/{group,ipc,extra}
            node /app/session-permissions-watcher.mjs --once
          `,
          ['-v', `${session}:/home/node/.claude`],
        ),
      ).toThrow();
      expect(fileSnapshot(canary)).toEqual(before);
    });

    test('mirror-root hardlinks are logged and skipped without mutation', () => {
      const group = fs.mkdtempSync(path.join(testRoot, 'hardlink-group-'));
      const outside = fs.mkdtempSync(path.join(testRoot, 'hardlink-mirror-'));
      const canary = path.join(outside, 'canary');
      fs.writeFileSync(canary, 'mirror-hardlink-canary', { mode: 0o640 });
      fs.chmodSync(canary, 0o640);
      fs.linkSync(canary, path.join(group, 'inside-link'));
      const before = fileSnapshot(canary);

      expect(
        runImageScript(
          `
            mkdir -p /home/node/.claude /workspace/{ipc,extra}
            message=$(node /app/session-permissions-watcher.mjs --once 2>&1)
            printf '%s' "$message"
          `,
          ['-v', `${group}:/workspace/group`],
        ),
      ).toContain('skipping multiply-linked inode');
      expect(fileSnapshot(canary)).toEqual(before);
    });

    test('host-root live watcher repairs new root-owned entries privately', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          MINICLAW_HOST_IDENTITY_MODE=host-root
          miniclaw_configure_node_identity
          miniclaw_prepare_mounted_paths
          miniclaw_start_session_permission_watcher
          install -d -o 0 -g 0 -m 0700 /workspace/group/live
          install -o 0 -g 0 -m 0600 /dev/null /workspace/group/live/file
          for attempt in $(seq 1 200); do
            [ "$(stat -c '%u:%g:%a' /workspace/group/live/file)" = \
              "$(id -u node):$(id -g node):600" ] && break
            sleep 0.02
          done
          setpriv --reuid="$(id -u node)" --regid="$(id -g node)" \
            --clear-groups -- test -r /workspace/group/live/file
          test "$(stat -c %a /workspace/group/live)" = 700
          test "$(stat -c %a /workspace/group/live/file)" = 600
          miniclaw_stop_session_permission_watcher
          printf repaired
        `),
      ).toBe('repaired');
    });

    test('fixed generated roots reject persistent symlink traversal', () => {
      const extra = fs.mkdtempSync(path.join(testRoot, 'generated-extra-'));
      const session = fs.mkdtempSync(path.join(testRoot, 'generated-session-'));
      const outside = fs.mkdtempSync(path.join(testRoot, 'generated-outside-'));
      const canary = path.join(outside, 'canary');
      fs.writeFileSync(canary, 'generated-path-canary', { mode: 0o640 });
      fs.symlinkSync('/tmp/generated-outside', path.join(extra, '.npm-global'));
      fs.symlinkSync('/tmp/generated-outside', path.join(session, 'skills'));
      const before = fileSnapshot(canary);

      for (const operation of ['--ensure-npm-global', '--reset-skills']) {
        expect(() =>
          runImageScript(`node /app/session-generated-paths.mjs ${operation}`, [
            '-v',
            `${extra}:/workspace/extra`,
            '-v',
            `${session}:/home/node/.claude`,
            '-v',
            `${outside}:/tmp/generated-outside`,
          ]),
        ).toThrow();
        expect(fileSnapshot(canary)).toEqual(before);
        expect(fs.existsSync(path.join(outside, 'bin'))).toBe(false);
        expect(fs.existsSync(path.join(outside, 'lib'))).toBe(false);
      }
    });

    test('restrictive prompt bind is copied read-only without touching source', () => {
      const prompts = fs.mkdtempSync(path.join(testRoot, 'runtime-prompts-'));
      const prompt = path.join(prompts, 'identity.miniclaw.md');
      fs.writeFileSync(prompt, 'runtime prompt', { mode: 0o600 });
      fs.chmodSync(prompts, 0o700);
      fs.chmodSync(prompt, 0o600);
      const before = fileSnapshot(prompt);

      expect(
        runImageScript(
          `
            node /app/session-prompts-copy.mjs
            test "$(stat -c '%u:%g:%a' /tmp/prompts)" = '0:0:555'
            test "$(stat -c '%u:%g:%a' /tmp/prompts/identity.miniclaw.md)" = \
              '0:0:444'
            setpriv --reuid="$(id -u node)" --regid="$(id -g node)" \
              --clear-groups -- sh -ceu '
                test "$(cat /tmp/prompts/identity.miniclaw.md)" = "runtime prompt"
                test ! -w /tmp/prompts/identity.miniclaw.md
                test ! -w /app/prompts/identity.miniclaw.md
              '
            printf copied
          `,
          ['-v', `${prompts}:/app/prompts:ro`],
        ),
      ).toBe('copied');
      expect(fileSnapshot(prompt)).toEqual(before);
    });

    test('refuses host-encrypted env and prompt bytes before consuming them', () => {
      const envResult = runHelper(
        `
        printf '%s\n' '%TSD-Header-###%' 'SHOULD_NOT_RUN=yes' > /workspace/env-dir/env
        export MINICLAW_HOST_IDENTITY_MODE=virtualized MINICLAW_INTERNAL_IDENTITY_MODE=virtualized
        export MINICLAW_INTERNAL_RUNTIME_UID=1000 MINICLAW_INTERNAL_RUNTIME_GID=1000 MINICLAW_INTERNAL_WATCHER_PID=''
        if miniclaw_source_runtime_env; then exit 1; fi
        test -z "\${SHOULD_NOT_RUN:-}"
        printf blocked
      `,
        ['--tmpfs', '/workspace/env-dir'],
      );
      expect(envResult).toBe('blocked');
      const promptResult = runHelper(
        `
        printf '%s' '%TSD-Header-###%fake-ciphertext' > /app/prompts/fixture.md
        if node /app/session-prompts-copy.mjs >/tmp/prompt-output 2>&1; then exit 1; fi
        grep -q 'prompt bind contains a host-encrypted file' /tmp/prompt-output
        printf blocked
      `,
        ['--tmpfs', '/app/prompts'],
      );
      expect(promptResult).toBe('blocked');
    });

    test('node git config permits a root-owned group-readable repository', () => {
      expect(
        runImageScript(`
          repository=$(mktemp -d)
          git -C "$repository" init -q
          touch "$repository/tracked"
          chown -R 0:"$(id -g node)" "$repository"
          find "$repository" -type d -exec chmod 2770 {} +
          find "$repository" -type f -exec chmod 0660 {} +
          runuser -u node -- env HOME=/home/node /usr/bin/git \
            config --global --add safe.directory '*'
          runuser -u node -- env HOME=/home/node /usr/bin/git \
            -C "$repository" status --short >/dev/null
          test -f /home/node/.gitconfig
          printf trusted
        `),
      ).toBe('trusted');
    });

    test('runtime env cannot override root-control variables', () => {
      const envDir = fs.mkdtempSync(path.join(testRoot, 'malicious-env-'));
      fs.writeFileSync(
        path.join(envDir, 'env'),
        [
          "MINICLAW_HOST_IDENTITY_MODE='unknown'",
          "MINICLAW_INTERNAL_IDENTITY_MODE='pwned'",
          "MINICLAW_INTERNAL_WATCHER_PID='1'",
          "MINICLAW_SESSION_ROOT='/'",
          "MINICLAW_SESSION_PERMISSION_HELPER='/workspace/group/evil.sh'",
          "PROJECT_ENV='kept'",
        ].join('\n'),
        { mode: 0o600 },
      );
      expect(
        runHelper(
          `
            MINICLAW_HOST_IDENTITY_MODE=direct
            MINICLAW_INTERNAL_IDENTITY_MODE=direct
            MINICLAW_INTERNAL_WATCHER_PID=4242
            miniclaw_source_runtime_env
            printf '%s:%s:%s:%s' \
              "$MINICLAW_HOST_IDENTITY_MODE" \
              "$MINICLAW_INTERNAL_IDENTITY_MODE" \
              "$MINICLAW_INTERNAL_WATCHER_PID" \
              "$PROJECT_ENV"
          `,
          ['-v', `${envDir}:/workspace/env-dir:ro`],
        ),
      ).toBe('direct:direct:4242:kept');
    });

    test('native child lookup pins special entries without opening their contents', () => {
      expect(
        runHelper(`
          mkdir -p /tmp/native-path-fixture
          chown node:node /tmp/native-path-fixture
          chmod 0700 /tmp/native-path-fixture
          mkfifo /tmp/native-path-fixture/pipe
          ln -s /etc/passwd /tmp/native-path-fixture/link
          node --input-type=module <<'NODE'
          import assert from 'node:assert/strict';
          import fs from 'node:fs';
          import { createRequire } from 'node:module';
          const native = createRequire(import.meta.url)('/app/native/session-watch-identity.node');
          const parent = fs.openSync('/tmp/native-path-fixture', 'r');
          try {
            for (const [name, kind] of [['pipe', 'fifo'], ['link', 'symlink']]) {
              const fd = native.openChildAsNode(parent, Buffer.from(name), 1000, 1000);
              try {
                const stat = fs.fstatSync(fd);
                assert.equal(kind === 'fifo' ? stat.isFIFO() : stat.isSymbolicLink(), true);
                const info = fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8');
                const flags = /^flags:\\s+([0-7]+)$/m.exec(info);
                assert.ok(flags);
                assert.notEqual(parseInt(flags[1], 8) & 0x200000, 0);
              } finally { fs.closeSync(fd); }
            }
          } finally { fs.closeSync(parent); }
          process.stdout.write('pinned-without-content');
NODE
        `),
      ).toBe('pinned-without-content');
    });

    test('native virtualized watcher keeps SDK locks live and protects new directories', () => {
      const mountedSession = fs.mkdtempSync(path.join(testRoot, 'native-session-'));
      try {
        expect(
          runHelper(`
            mkdir -p /home/node/.claude/agent /workspace/{group,ipc,extra}
            chown -R node:node /home/node/.claude /workspace/{group,ipc,extra}
            export MINICLAW_INTERNAL_IDENTITY_MODE=virtualized
            node /app/session-permissions-watcher.mjs --watch-node-owned-mounts --native-watch >/tmp/native-watch.log 2>&1 &
            watcher_pid=$!
            trap 'kill "$watcher_pid" 2>/dev/null || true; wait "$watcher_pid" 2>/dev/null || true; chmod -R a+rwx /home/node/.claude' EXIT
            for attempt in $(seq 1 500); do
              [ -e /run/miniclaw-session-watcher.ready ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            test -e /run/miniclaw-session-watcher.ready
            if setpriv --reuid=node --regid=node --clear-groups -- kill -KILL "$watcher_pid" 2>/dev/null; then
              echo 'unprivileged user could kill watcher' >&2
              exit 1
            fi
            setpriv --reuid=node --regid=node --clear-groups -- node --input-type=module -e '
              import { AuthStorage } from "/app/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
              import fs from "node:fs";
              const file = "/home/node/.claude/agent/auth.json";
              for (let i = 0; i < 100; i++) {
                fs.rmSync(file, { force: true });
                await AuthStorage.create(file).read("synthetic");
              }
            '
            setpriv --reuid=node --regid=node --clear-groups -- sh -c 'umask 000; mkdir /home/node/.claude/agent/persistent'
            for attempt in $(seq 1 500); do
              [ "$(stat -c %a /home/node/.claude/agent/persistent)" = 700 ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            test "$(stat -c %a /home/node/.claude/agent/persistent)" = 700
            test ! -e /run/miniclaw-session-watcher.failed
            kill -0 "$watcher_pid"
            kill "$watcher_pid"
            wait "$watcher_pid"
            chmod -R a+rwx /home/node/.claude
            trap - EXIT
            printf 'sdk-locks-and-protection-ok'
          `, ['--mount', `type=bind,src=${mountedSession},dst=/home/node/.claude`]),
        ).toBe('sdk-locks-and-protection-ok');
      } finally {
        fs.rmSync(mountedSession, { recursive: true, force: true });
      }
    }, 60_000);

    test('one-shot bridge removes other bits without following symlinks', () => {
      expect(
        runHelper(`
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          credential=/home/node/.claude/.credentials.json
          outside=$(mktemp)
          touch "$credential"
          chmod 0600 "$credential" "$outside"
          ln -s "$outside" /home/node/.claude/outside-link
          mkdir -p $'/home/node/.claude/newline\n..'/nested
          touch $'/home/node/.claude/newline\n..'/nested/transcript.jsonl
          chmod 0600 $'/home/node/.claude/newline\n..'/nested/transcript.jsonl
          node /app/session-permissions-watcher.mjs --once
          printf '%s|%s|%s|%s' \
            "$(stat -c '%u:%g:%a' "$credential")" \
            "$(stat -c '%a' /home/node/.claude)" \
            "$(stat -c '%a' $'/home/node/.claude/newline\n..'/nested/transcript.jsonl)" \
            "$(stat -c '%a' "$outside")"
          setpriv --reuid=12345 --regid=12345 --clear-groups -- \
            test ! -r "$credential"
        `),
      ).toBe('0:1000:660|2770|660|600');
    });

    test('descriptor bridge resists file-to-symlink swaps', () => {
      expect(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            outside=$(mktemp)
            printf 'outside-canary' > "$outside"
            chown 12345:12345 "$outside"
            chmod 0640 "$outside"
            node /app/session-permissions-watcher.mjs &
            watcher_pid=$!
            for attempt in $(seq 1 200); do
              [ -e /run/miniclaw-session-watcher.ready ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            for attempt in $(seq 1 2000); do
              rm -f /home/node/.claude/race
              install -m 0600 /dev/null /home/node/.claude/race
              rm -f /home/node/.claude/race
              ln -s "$outside" /home/node/.claude/race
            done
            rm -f /home/node/.claude/race
            sleep 0.1
            kill "$watcher_pid"
            wait "$watcher_pid"
            printf '%s:%s:%s' \
              "$(stat -c '%u:%g:%a' "$outside")" \
              "$(cat "$outside")" \
              "$([ -e /run/miniclaw-session-watcher.failed ] && echo failed || echo safe)"
          `),
      ).toBe('12345:12345:640:outside-canary:safe');
    }, 30_000);

    test('live watcher repairs restrictive files and moved-in subtrees', () => {
      expect(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            node /app/session-permissions-watcher.mjs &
            watcher_pid=$!
            for attempt in $(seq 1 200); do
              [ -e /run/miniclaw-session-watcher.ready ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            install -m 0600 /dev/null /home/node/.claude/live.jsonl
            incoming=$(mktemp -d)
            mkdir -p "$incoming/deep"
            install -m 0600 /dev/null "$incoming/deep/moved.jsonl"
            mv "$incoming" /home/node/.claude/moved
            for attempt in $(seq 1 200); do
              [ "$(stat -c %a /home/node/.claude/live.jsonl)" = 660 ] && \
                [ "$(stat -c %a /home/node/.claude/moved/deep/moved.jsonl)" = 660 ] && break
              sleep 0.02
            done
            modes="$(stat -c %a /home/node/.claude/live.jsonl):$(stat -c %a /home/node/.claude/moved/deep/moved.jsonl)"
            kill "$watcher_pid"
            wait "$watcher_pid"
            printf '%s:%s' "$modes" "$(kill -0 "$watcher_pid" 2>/dev/null && echo live || echo stopped)"
          `),
      ).toBe('660:660:stopped');
    }, 20_000);

    test('parses a real recursive fs.watch event in the agent image', () => {
      expect(
        runHelper(`
          node --input-type=module -e '
            import fs from "node:fs";
            import { watchRelativeComponents } from "/app/session-permissions-mount.mjs";
            fs.mkdirSync("/tmp/watch-parser-test", { recursive: true });
            const timeout = setTimeout(() => process.exit(2), 5000);
            let matched = false;
            const watch = fs.watch("/tmp/watch-parser-test", { recursive: true, encoding: "buffer" }, (_, name) => {
              const components = watchRelativeComponents(name);
              if (!matched && components?.length === 1 && components[0].toString() === "fixture") {
                matched = true;
                clearTimeout(timeout);
                watch.close();
                console.log("parsed");
              }
            });
            setTimeout(() => fs.writeFileSync("/tmp/watch-parser-test/fixture", "test"), 200);
          '
        `),
      ).toBe('parsed');
    }, 20_000);

    test('normalizes a 10000-file session in bounded startup time', () => {
      const elapsed = Number(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            start=$(date +%s%N)
            node -e "const fs=require('fs'); for(let i=0;i<10000;i++) fs.writeFileSync('/home/node/.claude/f'+i,'',{mode:0o600})"
            node /app/session-permissions-watcher.mjs --once
            end=$(date +%s%N)
            printf '%s' $(((end-start)/1000000))
          `),
      );
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10_000);
    }, 30_000);
  },
);
