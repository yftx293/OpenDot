import fs from 'node:fs';
import {
  preciseDescriptorIdentity,
  watchRescanKey,
} from '../session-permissions-mount.mjs';
import { reopenWatchedDirectory } from './session-watch-reopen.mjs';

const IN_MOVED_FROM = 0x00000040;
const IN_MOVED_TO = 0x00000080;
const IN_CREATE = 0x00000100;
const IN_DELETE = 0x00000200;

/** Resolve each wd against the inode registered during the scan. A removed or
 * replaced directory requires a new watch generation; filesystem access
 * errors and boundary violations must propagate to the fail-closed owner. */
export function reconcileWatchEvents(native, watches, events, normalize) {
  if (
    !(watches instanceof Map) ||
    !Array.isArray(events) ||
    typeof normalize !== 'function'
  )
    throw new Error('Invalid permission event reconciliation');
  const knownPaths = new Set();
  const rootFds = new Set();
  for (const watch of watches.values()) {
    knownPaths.add(watchRescanKey(watch.root.path, watch.components));
    rootFds.add(watch.root.fd);
  }
  const pending = new Map();
  let rebuild = false;
  for (const event of events) {
    const watch = watches.get(event.wd);
    if (!watch) throw new Error('Permission event has no verified directory');
    if (event.coverageLost) {
      // A vanished child is expected during ordinary file operations. A lost
      // root watch is different: its fixed mount authority is no longer valid.
      if (watch.components.length === 0)
        throw new Error('Permission watch root was removed or replaced');
      rebuild = true;
      continue;
    }
    const parent = reopenWatchedDirectory(native, watch, normalize);
    if (!parent) {
      rebuild = true;
      continue;
    }
    try {
      if (event.name === null) continue; // The reopened directory was normalized.
      if (!Buffer.isBuffer(event.name))
        throw new Error('Invalid permission event name');
      const components = [...watch.components, Buffer.from(event.name)];
      const key = watchRescanKey(watch.root.path, components);
      const wasWatched = knownPaths.has(key);
      if (
        event.directory &&
        wasWatched &&
        event.mask & (IN_DELETE | IN_MOVED_FROM)
      ) {
        rebuild = true;
        continue;
      }
      const child = native.openChildAsNode(
        parent.fd,
        event.name,
        watch.root.uid,
        watch.root.gid,
      );
      if (child === null) continue;
      if (
        !Number.isSafeInteger(child) ||
        child < 0 ||
        child === parent.fd ||
        rootFds.has(child)
      )
        throw new Error('Invalid event target descriptor');
      try {
        if (
          event.mask & (IN_CREATE | IN_MOVED_TO) &&
          watch.root.virtualizedOwnership instanceof Map
        ) {
          // A deleted inode number can be reused before the next full scan.
          // A new directory entry must not inherit an earlier entry's cached
          // virtualized chown result, even if the mapped IDs look identical.
          const identity = preciseDescriptorIdentity(child, fs.fstatSync(child));
          watch.root.virtualizedOwnership.delete(
            `${identity.device}:${identity.inode}:${watch.root.uid}:${watch.root.gid}`,
          );
        }
        const proof = normalize(child, watch.root, false);
        if (
          !proof?.stat ||
          typeof proof.stat.isDirectory !== 'function' ||
          typeof proof.outsideRootMount !== 'boolean'
        )
          throw new Error('Missing event target boundary proof');
        if (proof.outsideRootMount) continue;
        if (
          proof.stat.isDirectory() &&
          !wasWatched &&
          event.mask & (IN_CREATE | IN_MOVED_TO | IN_DELETE | IN_MOVED_FROM)
        ) {
          const { device, inode } = preciseDescriptorIdentity(
            child,
            proof.stat,
          );
          // Different short-lived directories may reuse a path. Preserve each
          // observed inode so one timer cannot hide a later persistent inode.
          pending.set(JSON.stringify([key, device, inode]), {
            root: watch.root,
            components,
            device,
            inode,
          });
        }
      } finally {
        fs.closeSync(child);
      }
    } finally {
      parent.close();
    }
  }
  return { rebuild, pending: [...pending.values()] };
}
