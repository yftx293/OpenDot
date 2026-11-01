#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';

import {
  readDescriptorMountId,
  recordWatchRecovery,
  reconcileDescriptorOwnership,
  watchRelativeComponents,
  watchRescanKey,
} from './session-permissions-mount.mjs';

const READY_FILE = '/run/miniclaw-session-watcher.ready';
const FAILED_FILE = '/run/miniclaw-session-watcher.failed';
const RESCAN_INTERVAL_MS = 30_000;
const RECOVERY_LOSS_WINDOW_MS = 10_000;
const MAX_RECOVERY_LOSSES = 8;
const OPEN_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
const ROOT_OPEN_FLAGS = OPEN_FLAGS | fs.constants.O_DIRECTORY;

const passwdEntry = fs
  .readFileSync('/etc/passwd', 'utf8')
  .split('\n')
  .find((line) => line.startsWith('node:'));
if (!passwdEntry) throw new Error('node passwd entry is missing');
const nodeUid = Number(passwdEntry.split(':')[2]);
const nodeGid = Number(passwdEntry.split(':')[3]);
if (
  !Number.isSafeInteger(nodeUid) ||
  nodeUid <= 0 ||
  !Number.isSafeInteger(nodeGid) ||
  nodeGid <= 0
) {
  throw new Error('node uid or primary gid is invalid');
}
const nativeRequested = process.argv.includes('--native-watch');
const directMigration = process.argv.includes('--migrate-direct');
const directMountRoots = process.argv.includes(
  '--normalize-direct-mount-roots',
);
const nodeOwnedMounts = process.argv.includes('--normalize-node-owned-mounts');
const nodeOwnedWatch = process.argv.includes('--watch-node-owned-mounts');
const generatedOption = process.argv.find((argument) =>
  argument.startsWith('--normalize-generated='),
);
const generatedKey = generatedOption?.slice('--normalize-generated='.length);
const oneShotOperationCount = [
  directMigration,
  directMountRoots,
  nodeOwnedMounts,
  generatedKey !== undefined,
].filter(Boolean).length;
if (oneShotOperationCount > 1) {
  throw new Error(
    'multiple permission normalization operations were requested',
  );
}
if (nodeOwnedWatch && oneShotOperationCount > 0) {
  throw new Error('live and one-shot permission operations cannot be combined');
}
if (
  nativeRequested &&
  (directMigration || directMountRoots || generatedKey !== undefined)
) {
  throw new Error(
    'native prototype supports only mounted live or node-owned scans',
  );
}
// The virtualized-mount entrypoint passes this flag. Missing or incompatible
// native code fails startup instead of silently changing permission policy.
const native = nativeRequested
  ? createRequire(import.meta.url)('./native/session-watch-identity.node')
  : null;
const NativeWatchSupervisor = nativeRequested
  ? (await import('./native/session-watch-supervisor.mjs'))
      .NativeWatchSupervisor
  : null;

// These are the only writable bind roots the root watcher may touch. Session,
// CLI state and IPC use fixed data modes. Workspace and durable extra files
// mirror their owner's rwx bits to the node group so executable intent survives.
const mountedRoots = [
  {
    path: '/home/node/.claude',
    policy: 'managed',
    directMigration: true,
  },
  {
    path: '/home/node/.feishu-cli',
    policy: 'managed',
    optional: true,
    directMigration: true,
  },
  { path: '/workspace/ipc', policy: 'managed' },
  { path: '/workspace/group', policy: 'mirror' },
  { path: '/workspace/extra', policy: 'mirror' },
];

const generatedRoots = new Map([
  [
    'npm-global',
    {
      path: '/workspace/extra/.npm-global',
      policy: 'mirror',
      normalization: 'node-owned',
    },
  ],
  [
    'skills',
    {
      path: '/home/node/.claude/skills',
      policy: 'managed',
      normalization: 'node-owned',
    },
  ],
  [
    'dist',
    {
      path: '/tmp/dist',
      policy: 'managed',
      normalization: 'node-readonly',
    },
  ],
  [
    'chromium',
    {
      path: '/tmp/miniclaw-chromium-profile',
      policy: 'managed',
      normalization: 'node-owned',
    },
  ],
]);

let roots;
if (generatedKey !== undefined) {
  const generatedRoot = generatedRoots.get(generatedKey);
  if (!generatedRoot) {
    throw new Error(`unknown generated permission root: ${generatedKey}`);
  }
  roots = [{ ...generatedRoot }];
} else {
  roots = mountedRoots.map((root) => ({
    ...root,
    normalization: directMigration
      ? 'direct-migration'
      : directMountRoots || nodeOwnedMounts || nodeOwnedWatch
        ? 'node-owned'
        : 'shared',
    rootOnly: directMountRoots,
    virtualizedOwnership:
      process.env.MINICLAW_INTERNAL_IDENTITY_MODE === 'virtualized' &&
      (nodeOwnedMounts || nodeOwnedWatch)
        ? new Map()
        : undefined,
  }));
}

if (native)
  for (const root of roots) {
    root.uid = nodeUid;
    root.gid = nodeGid;
  }
const descriptorIO = native
  ? { fchownSync: native.chownPinned, fstatSync: fs.fstatSync }
  : fs;
let nativeSupervisor;

const watchers = new Map();
const recoveryLosses = new Map();
const pendingDirectoryRescans = new Set();
let stopping = false;
let periodicTimer;

function isReadonlyError(error) {
  return error && (error.code === 'EROFS' || error.code === 'ENOTSUP');
}

function isVanishedOrSymlink(error) {
  return (
    error &&
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      error.code === 'ELOOP' ||
      error.code === 'ENXIO')
  );
}

function procFdPath(fd) {
  return `/proc/self/fd/${fd}`;
}

function procFdChildPath(parentFd, component) {
  return Buffer.concat([Buffer.from(`${procFdPath(parentFd)}/`), component]);
}

function openChild(parentFd, component) {
  try {
    // /proc/self/fd/<parent>/<name> gives Node an openat-like operation. The
    // parent descriptor is already beneath a fixed root and O_NOFOLLOW applies
    // to the untrusted final component.
    return fs.openSync(procFdChildPath(parentFd, component), OPEN_FLAGS);
  } catch (error) {
    if (isVanishedOrSymlink(error)) return null;
    throw error;
  }
}

function mirrorMode(stat, directory) {
  let ownerBits = (stat.mode >>> 6) & 0o7;
  if (ownerBits === 0) ownerBits = directory ? 0o7 : 0o6;
  const shared = (ownerBits << 6) | (ownerBits << 3);
  return directory ? 0o2000 | shared : shared;
}

function secureMode(stat, root) {
  if (root.normalization === 'direct-migration') {
    if (stat.isDirectory()) return 0o700;
    if (stat.isFile() || stat.isFIFO()) {
      return (stat.mode & 0o111) === 0 ? 0o600 : 0o700;
    }
    return null;
  }
  if (root.normalization === 'node-owned') {
    if (stat.isDirectory()) return 0o700;
    if (stat.isFile() || stat.isFIFO()) return stat.mode & 0o700;
    return null;
  }
  if (root.normalization === 'node-readonly') {
    if (stat.isDirectory()) return 0o500;
    if (stat.isFile()) return stat.mode & 0o500;
    return null;
  }
  if (stat.isDirectory()) {
    return root.policy === 'managed' ? 0o2770 : mirrorMode(stat, true);
  }
  if (stat.isFile() || stat.isFIFO()) {
    return root.policy === 'managed' ? 0o660 : mirrorMode(stat, false);
  }
  return null;
}

function inspectDescriptorBoundary(fd, root) {
  const stat = fs.fstatSync(fd);
  const mountId = readDescriptorMountId(fd);
  return {
    stat,
    outsideRootMount: stat.dev !== root.device || mountId !== root.mountId,
  };
}

function normalizeDescriptor(fd, root, required = false) {
  const { stat, outsideRootMount } = inspectDescriptorBoundary(fd, root);
  if (outsideRootMount) return { stat, outsideRootMount: true };
  const mode = secureMode(stat, root);
  if (mode === null) return { stat, outsideRootMount: false };

  let desiredUid;
  let desiredGid;
  if (root.normalization === 'direct-migration' && stat.uid !== 1000) {
    desiredUid = stat.uid;
    desiredGid = stat.gid;
  } else if (root.normalization === 'shared') {
    desiredUid = 0;
    desiredGid = nodeGid;
  } else {
    desiredUid = nodeUid;
    desiredGid = nodeGid;
  }
  const ownershipChanged = stat.uid !== desiredUid || stat.gid !== desiredGid;
  const modeChanged = (stat.mode & 0o7777) !== mode;
  if (
    !stat.isDirectory() &&
    stat.nlink > 1 &&
    (ownershipChanged || modeChanged)
  ) {
    const description =
      `multiply-linked inode ${stat.ino} under ${root.path} requires ` +
      'an ownership or mode change';
    if (
      root.policy === 'managed' ||
      root.normalization === 'direct-migration'
    ) {
      throw new Error(`refusing ${description}`);
    }
    process.stderr.write(`miniclaw: skipping ${description}\n`);
    return { stat, outsideRootMount: false };
  }
  try {
    // Every mutation is descriptor-based. An Agent may rename or replace the
    // directory entry, but it cannot redirect fchown/fchmod outside this fd.
    const ownershipApplied = reconcileDescriptorOwnership(
      fd,
      stat,
      desiredUid,
      desiredGid,
      root,
      descriptorIO,
    );
    if (ownershipApplied || modeChanged) {
      if (native) native.chmodPinned(fd, mode);
      else fs.fchmodSync(fd, mode);
    }
  } catch (error) {
    if (!isReadonlyError(error) || required) throw error;
  }
  return { stat, outsideRootMount: false };
}

function readDirectory(fd) {
  // readdir follows only this trusted procfs magic-link to the already-open
  // directory. Child opens are again anchored to the descriptor above.
  return fs.readdirSync(procFdPath(fd), {
    encoding: 'buffer',
    withFileTypes: true,
  });
}

function normalizeTreeFromDescriptor(
  root,
  startFd,
  closeStart,
  required = false,
) {
  const stack = [
    {
      fd: startFd,
      closeWhenDone: closeStart,
      entered: false,
      entries: [],
      index: 0,
      required,
    },
  ];

  try {
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        const result = normalizeDescriptor(frame.fd, root, frame.required);
        frame.entered = true;
        if (!result.stat.isDirectory() || result.outsideRootMount) {
          if (frame.closeWhenDone) fs.closeSync(frame.fd);
          stack.pop();
          continue;
        }
        try {
          frame.entries = readDirectory(frame.fd);
        } catch (error) {
          if (!isReadonlyError(error) || frame.required) throw error;
          frame.entries = [];
        }
      }

      if (frame.index >= frame.entries.length) {
        if (frame.closeWhenDone) fs.closeSync(frame.fd);
        stack.pop();
        continue;
      }

      const entry = frame.entries[frame.index];
      frame.index += 1;
      const childFd = openChild(frame.fd, entry.name);
      if (childFd === null) continue;
      stack.push({
        fd: childFd,
        closeWhenDone: true,
        entered: false,
        entries: [],
        index: 0,
        required: false,
      });
    }
  } finally {
    for (const frame of stack) {
      if (frame.closeWhenDone) {
        try {
          fs.closeSync(frame.fd);
        } catch {}
      }
    }
  }
}

function initializeRoots() {
  for (const root of roots) {
    if (directMigration && !root.directMigration) {
      root.active = false;
      continue;
    }
    try {
      root.fd = fs.openSync(root.path, ROOT_OPEN_FLAGS);
      const stat = fs.fstatSync(root.fd);
      if (!stat.isDirectory())
        throw new Error(`${root.path} is not a directory`);
      root.device = stat.dev;
      root.mountId = readDescriptorMountId(root.fd);
      root.active = true;
    } catch (error) {
      if (root.optional && error?.code === 'ENOENT') {
        root.active = false;
        continue;
      }
      throw error;
    }
  }
}

function closeRoots() {
  for (const root of roots) {
    if (!root.active || root.fd === undefined) continue;
    try {
      fs.closeSync(root.fd);
    } catch {}
    root.fd = undefined;
    root.active = false;
  }
}

function normalizeRoot(root) {
  if (!root.active) return;
  if (root.virtualizedOwnership) root.virtualizedOwnershipSeen = new Set();
  try {
    if (root.rootOnly) {
      normalizeDescriptor(root.fd, root, true);
    } else {
      normalizeTreeFromDescriptor(root, root.fd, false, true);
    }
    // Keep mappings for live inodes across full scans. An arbitrary cache cap
    // would repeatedly evict and rewrite files in a large virtualized mount.
    if (root.virtualizedOwnershipSeen) {
      for (const key of root.virtualizedOwnership.keys()) {
        if (!root.virtualizedOwnershipSeen.has(key))
          root.virtualizedOwnership.delete(key);
      }
    }
  } finally {
    root.virtualizedOwnershipSeen = undefined;
  }
}

function normalizeAll() {
  for (const root of roots) normalizeRoot(root);
}

function openEventTarget(root, components) {
  let parentFd = root.fd;
  let parentOwned = false;
  try {
    for (const component of components) {
      const childFd = openChild(parentFd, component);
      if (parentOwned) fs.closeSync(parentFd);
      parentOwned = false;
      if (childFd === null) return null;
      const { outsideRootMount } = inspectDescriptorBoundary(childFd, root);
      if (outsideRootMount) {
        fs.closeSync(childFd);
        return null;
      }
      parentFd = childFd;
      parentOwned = true;
    }
    return parentOwned ? parentFd : null;
  } catch (error) {
    if (parentOwned) {
      try {
        fs.closeSync(parentFd);
      } catch {}
    }
    throw error;
  }
}

function failClosed(error) {
  if (stopping) return;
  stopping = true;
  try {
    fs.writeFileSync(FAILED_FILE, `${error?.stack ?? error}\n`, {
      mode: 0o600,
    });
  } catch {}
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  if (periodicTimer) clearInterval(periodicTimer);
  closeRoots();
  try {
    process.kill(1, 'SIGTERM');
  } finally {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref();
  }
}

function rescanEventTarget(root, components) {
  const targetFd = openEventTarget(root, components);
  if (targetFd === null) return;
  normalizeTreeFromDescriptor(root, targetFd, true, false);
}

function scheduleDirectoryRescan(root, components) {
  const key = watchRescanKey(root.path, components);
  if (pendingDirectoryRescans.has(key)) return;
  pendingDirectoryRescans.add(key);
  const stableComponents = components.map((component) =>
    Buffer.from(component),
  );
  setTimeout(() => {
    pendingDirectoryRescans.delete(key);
    try {
      rescanEventTarget(root, stableComponents);
    } catch (error) {
      recoverRoot(root.path, error);
    }
  }, 50).unref();
}

function handleEvent(root, relativeName) {
  if (stopping) return;
  const components = watchRelativeComponents(relativeName);
  if (!components) {
    recoverRoot(
      root.path,
      new Error('watch event omitted or escaped its relative path'),
    );
    return;
  }
  try {
    const targetFd = openEventTarget(root, components);
    if (targetFd === null) return;
    const stat = fs.fstatSync(targetFd);
    normalizeTreeFromDescriptor(root, targetFd, true, false);
    if (stat.isDirectory()) scheduleDirectoryRescan(root, components);
  } catch (error) {
    recoverRoot(root.path, error);
  }
}

function startWatch(root) {
  const watcher = fs.watch(
    root.path,
    { recursive: true, encoding: 'buffer' },
    (_eventType, relativeName) => {
      // A replaced watch can deliver an already queued callback after close.
      // The recovery scans cover its gap; it must not mutate the new watch.
      if (watchers.get(root.path) === watcher) handleEvent(root, relativeName);
    },
  );
  watcher.on('error', (error) => {
    if (watchers.get(root.path) === watcher) recoverRoot(root.path, error);
  });
  watchers.set(root.path, watcher);
}

function recoverRoot(rootPath, cause) {
  if (stopping) return;
  const root = roots.find((candidate) => candidate.path === rootPath);
  if (!root?.active) return failClosed(cause);
  const loss = recordWatchRecovery(
    recoveryLosses.get(rootPath) ?? [],
    performance.now(),
    RECOVERY_LOSS_WINDOW_MS,
    MAX_RECOVERY_LOSSES,
  );
  recoveryLosses.set(rootPath, loss.recent);
  if (loss.exhausted)
    return failClosed(
      new Error(`permission watcher repeatedly lost events on ${rootPath}`, {
        cause,
      }),
    );
  watchers.get(rootPath)?.close();
  watchers.delete(rootPath);
  try {
    // An overflow, missing filename or watch error loses incremental authority.
    // Scan before and after re-registration to close the complete gap.
    normalizeRoot(root);
    startWatch(root);
    normalizeRoot(root);
  } catch (error) {
    // A failed scan or re-registration leaves incremental coverage unknown.
    // Do not let the agent run during a delayed retry without a trusted watch.
    failClosed(error);
  }
}

async function nativeNormalizeOnce() {
  // A one-shot scan still registers watches and drains initial events. This
  // matters when another container is using the same session during startup.
  const once = new NativeWatchSupervisor(
    native,
    roots,
    normalizeDescriptor,
    failClosed,
  );
  try {
    await once.start();
  } finally {
    await once.stop();
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (periodicTimer) clearInterval(periodicTimer);
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  try {
    if (nativeSupervisor) await nativeSupervisor.stop();
    if (native) await nativeNormalizeOnce();
    else normalizeAll();
    closeRoots();
    process.exit(0);
  } catch (error) {
    closeRoots();
    process.stderr.write(
      `miniclaw permission watcher final scan failed: ${error}\n`,
    );
    process.exit(1);
  }
}

try {
  initializeRoots();
  if (process.argv.includes('--once') || oneShotOperationCount > 0) {
    if (native) await nativeNormalizeOnce();
    else normalizeAll();
    closeRoots();
    process.exit(0);
  }
  if (native) {
    nativeSupervisor = new NativeWatchSupervisor(
      native,
      roots,
      normalizeDescriptor,
      failClosed,
    );
    await nativeSupervisor.start();
  } else {
    normalizeAll();
    for (const root of roots) {
      if (root.active) startWatch(root);
    }
    normalizeAll();
    periodicTimer = setInterval(() => {
      try {
        normalizeAll();
      } catch (error) {
        failClosed(error);
      }
    }, RESCAN_INTERVAL_MS);
    periodicTimer.unref();
  }
  fs.writeFileSync(READY_FILE, 'ready\n', { mode: 0o600 });
  process.on('SIGTERM', () => {
    void stop();
  });
  process.on('SIGINT', () => {
    void stop();
  });
} catch (error) {
  failClosed(error);
}
