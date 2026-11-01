import fs from 'node:fs';
import {
  preciseDescriptorIdentity,
  watchRescanKey,
} from '../session-permissions-mount.mjs';

/** Re-open each directory component beneath the fixed root using node's
 * filesystem identity. A vanished entry, symlink, file or nested mount is not
 * a directory that this authority should watch. All other errors propagate. */
export function checkPendingDirectory(native, item, normalize) {
  const { root, components, device, inode } = item ?? {};
  if (
    !root?.active ||
    !Number.isSafeInteger(root.fd) ||
    root.fd < 0 ||
    !Number.isSafeInteger(root.uid) ||
    root.uid <= 0 ||
    !Number.isSafeInteger(root.gid) ||
    root.gid <= 0 ||
    !Array.isArray(components) ||
    !components.length ||
    components.length > 128 ||
    typeof device !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(device) ||
    typeof inode !== 'string' ||
    !/^[1-9][0-9]*$/.test(inode) ||
    typeof normalize !== 'function'
  )
    throw new Error('Invalid pending permission directory');
  const opened = [];
  let parent = root.fd;
  let lastStat;
  try {
    for (const component of components) {
      if (!Buffer.isBuffer(component))
        throw new Error('Invalid directory component');
      const fd = native.openChildAsNode(parent, component, root.uid, root.gid);
      if (fd === null) return false;
      if (
        !Number.isSafeInteger(fd) ||
        fd < 0 ||
        fd === root.fd ||
        opened.includes(fd)
      )
        throw new Error('Invalid pending directory descriptor');
      opened.push(fd);
      const proof = normalize(fd, root, false);
      if (
        !proof?.stat ||
        typeof proof.stat.isDirectory !== 'function' ||
        typeof proof.outsideRootMount !== 'boolean'
      )
        throw new Error('Missing pending directory boundary proof');
      if (proof.outsideRootMount || !proof.stat.isDirectory()) return false;
      lastStat = proof.stat;
      parent = fd;
    }
    const identity = preciseDescriptorIdentity(parent, lastStat);
    return identity.device === device && identity.inode === inode;
  } finally {
    let closeError;
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError) throw closeError;
  }
}

/** Coalesce raw-byte paths without collisions. Persistent directories request
 * a full new watch generation; no entry is skipped by filename. The owner must
 * dispose these timers before closing a generation's root descriptors. */
export class PendingDirectoryChecks {
  #timers = new Map();
  #closed = false;
  #idleWaiters = [];
  constructor(native, normalize, onPersistent, onFailure, options = {}) {
    if (
      typeof normalize !== 'function' ||
      typeof onPersistent !== 'function' ||
      typeof onFailure !== 'function'
    )
      throw new Error('Invalid pending check handlers');
    this.native = native;
    this.normalize = normalize;
    this.onPersistent = onPersistent;
    this.onFailure = onFailure;
    this.delayMs = options.delayMs ?? 50;
    this.maxPending = options.maxPending ?? 4096;
    if (
      !Number.isSafeInteger(this.delayMs) ||
      this.delayMs < 1 ||
      this.delayMs > 1000 ||
      !Number.isSafeInteger(this.maxPending) ||
      this.maxPending < 1
    )
      throw new Error('Invalid pending check limits');
  }
  schedule(item) {
    if (this.#closed) throw new Error('Pending checks are closed');
    if (
      !item?.root ||
      typeof item.root.path !== 'string' ||
      !item.root.path ||
      !Array.isArray(item.components) ||
      !item.components.length ||
      !item.components.every(Buffer.isBuffer) ||
      typeof item.device !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(item.device) ||
      typeof item.inode !== 'string' ||
      !/^[1-9][0-9]*$/.test(item.inode)
    )
      throw new Error('Invalid pending path');
    const key = JSON.stringify([
      watchRescanKey(item.root.path, item.components),
      item.device,
      item.inode,
    ]);
    if (this.#timers.has(key)) return;
    if (this.#timers.size >= this.maxPending)
      throw new Error('Pending directory budget exceeded');
    const stable = {
      root: item.root,
      components: item.components.map((part) => Buffer.from(part)),
      device: item.device,
      inode: item.inode,
    };
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      if (this.#closed) return;
      try {
        if (checkPendingDirectory(this.native, stable, this.normalize))
          this.onPersistent(stable);
      } catch (error) {
        this.onFailure(error);
      } finally {
        this.#notifyIdle();
      }
    }, this.delayMs);
    timer.unref();
    this.#timers.set(key, timer);
  }
  #notifyIdle() {
    if (this.#timers.size) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
  whenIdle() {
    if (!this.#timers.size) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }
  close() {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#notifyIdle();
  }
}
