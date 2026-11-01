import fs from 'node:fs';
import { preciseDescriptorIdentity } from '../session-permissions-mount.mjs';

/** Build a fresh, descriptor-anchored set of non-recursive watches. Every
 * directory is watched before it is enumerated. Events queued while this
 * synchronous scan runs must be drained and reconciled before the caller may
 * declare readiness. */
export function scanAndWatchRoots(
  native,
  notifyFd,
  roots,
  normalize,
  options = {},
) {
  const maxDirectories = options.maxDirectories ?? 65536;
  const maxDepth = options.maxDepth ?? 128;
  if (
    !Number.isSafeInteger(notifyFd) ||
    notifyFd < 0 ||
    !Number.isSafeInteger(maxDirectories) ||
    maxDirectories < 1 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    !Array.isArray(roots) ||
    !roots.length ||
    typeof normalize !== 'function'
  )
    throw new Error('Invalid permission watch scan configuration');
  const watches = new Map();
  const owned = new Set();
  const closeOwned = () => {
    for (const fd of owned) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    owned.clear();
  };
  const stack = [];
  const mappedRoots = [];
  let completed = false;
  try {
    for (const root of roots) {
      if (!root.active) continue;
      if (root.virtualizedOwnership) {
        if (
          !(root.virtualizedOwnership instanceof Map) ||
          root.virtualizedOwnershipSeen !== undefined
        )
          throw new Error('Invalid virtualized ownership scan');
        root.virtualizedOwnershipSeen = new Set();
        mappedRoots.push(root);
      }
      if (
        !Number.isSafeInteger(root.fd) ||
        root.fd < 0 ||
        !Number.isSafeInteger(root.uid) ||
        root.uid <= 0 ||
        !Number.isSafeInteger(root.gid) ||
        root.gid <= 0
      )
        throw new Error('Invalid mounted root identity');
      stack.push({
        root,
        fd: root.fd,
        owned: false,
        components: [],
        entered: false,
        entries: [],
        index: 0,
      });
    }
    while (stack.length) {
      const frame = stack.at(-1);
      if (!frame.entered) {
        // normalize must re-check descriptor device/mount boundaries and use
        // descriptor-based ownership/mode changes. It returns the same proof
        // as the current watcher, never a path-derived stat.
        const proof = normalize(frame.fd, frame.root, !frame.owned);
        frame.entered = true;
        if (
          !proof?.stat ||
          typeof proof.stat.isDirectory !== 'function' ||
          typeof proof.outsideRootMount !== 'boolean'
        )
          throw new Error('Missing descriptor boundary proof');
        if (proof.outsideRootMount || !proof.stat.isDirectory()) {
          if (frame.owned) {
            fs.closeSync(frame.fd);
            owned.delete(frame.fd);
          }
          stack.pop();
          continue;
        }
        if (watches.size >= maxDirectories)
          throw new Error('Permission watch directory budget exceeded');
        const wd = native.addWatchAsNode(
          notifyFd,
          frame.fd,
          frame.root.uid,
          frame.root.gid,
        );
        // Inotify merges watches on the same inode. Two authorities must not
        // silently share one wd, even if a bind alias has appeared.
        if (!Number.isSafeInteger(wd) || wd < 0 || watches.has(wd))
          throw new Error('Ambiguous permission watch descriptor');
        const identity = preciseDescriptorIdentity(frame.fd, proof.stat);
        watches.set(wd, {
          root: frame.root,
          components: frame.components,
          ...identity,
        });
        frame.entries = native.listChildrenAsNode(
          frame.fd,
          frame.root.uid,
          frame.root.gid,
        );
        if (!Array.isArray(frame.entries))
          throw new Error('Invalid permission watch directory list');
      }
      if (frame.index >= frame.entries.length) {
        // Events re-open this raw-byte path and verify the pinned watch inode;
        // retain descriptors only for the active traversal depth.
        if (frame.owned) {
          fs.closeSync(frame.fd);
          owned.delete(frame.fd);
        }
        stack.pop();
        continue;
      }
      const name = frame.entries[frame.index++];
      if (!Buffer.isBuffer(name))
        throw new Error('Invalid directory entry bytes');
      if (frame.components.length >= maxDepth)
        throw new Error('Permission watch depth exceeded');
      const child = native.openChildAsNode(
        frame.fd,
        name,
        frame.root.uid,
        frame.root.gid,
      );
      if (child === null) continue; // Entry vanished or is a symlink.
      if (
        !Number.isSafeInteger(child) ||
        child < 0 ||
        owned.has(child) ||
        roots.some((root) => root.active && root.fd === child)
      )
        throw new Error('Invalid child descriptor');
      owned.add(child);
      stack.push({
        root: frame.root,
        fd: child,
        owned: true,
        components: [...frame.components, Buffer.from(name)],
        entered: false,
        entries: [],
        index: 0,
      });
    }
    if (!watches.size) throw new Error('No permission watch roots');
    completed = true;
    return { watches, close: closeOwned };
  } catch (error) {
    closeOwned();
    throw error;
  } finally {
    for (const root of mappedRoots) {
      if (completed) {
        for (const key of root.virtualizedOwnership.keys()) {
          if (!root.virtualizedOwnershipSeen.has(key))
            root.virtualizedOwnership.delete(key);
        }
      }
      root.virtualizedOwnershipSeen = undefined;
    }
  }
}
