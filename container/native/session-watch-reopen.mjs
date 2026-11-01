import fs from 'node:fs';
import { preciseDescriptorIdentity } from '../session-permissions-mount.mjs';

/** Re-open a watched directory from its fixed root without retaining one fd
 * per directory. The final inode must still be the inode registered with
 * inotify. A missing or replaced path asks the caller to rebuild the watch
 * generation; a mount/permission error must fail closed. */
export function reopenWatchedDirectory(native, watch, normalize) {
  const { root, components, device, inode } = watch ?? {};
  if (
    !root?.active ||
    !Number.isSafeInteger(root.fd) ||
    root.fd < 0 ||
    !Number.isSafeInteger(root.uid) ||
    root.uid < 1 ||
    !Number.isSafeInteger(root.gid) ||
    root.gid < 1 ||
    !Array.isArray(components) ||
    components.length > 128 ||
    !components.every(Buffer.isBuffer) ||
    typeof device !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(device) ||
    typeof inode !== 'string' ||
    !/^[1-9][0-9]*$/.test(inode) ||
    typeof normalize !== 'function'
  )
    throw new Error('Invalid watched directory identity');
  const opened = [];
  let current = root.fd;
  let retained = null;
  try {
    for (const component of components) {
      const child = native.openChildAsNode(
        current,
        component,
        root.uid,
        root.gid,
      );
      if (child === null) return null;
      if (
        !Number.isSafeInteger(child) ||
        child < 0 ||
        child === root.fd ||
        opened.includes(child)
      )
        throw new Error('Invalid reopened directory descriptor');
      opened.push(child);
      const proof = normalize(child, root, false);
      if (
        !proof?.stat ||
        typeof proof.stat.isDirectory !== 'function' ||
        typeof proof.outsideRootMount !== 'boolean'
      )
        throw new Error('Missing reopened directory boundary proof');
      if (proof.outsideRootMount)
        throw new Error('Watched directory crossed mount boundary');
      if (!proof.stat.isDirectory()) return null;
      current = child;
    }
    // The root path has no child components and still needs fresh boundary and
    // inode proof. Other directories were normalized above; fstat reads only
    // the already-open descriptor and cannot follow a replacement path.
    const proof = normalize(current, root, components.length === 0);
    if (
      !proof?.stat ||
      typeof proof.stat.isDirectory !== 'function' ||
      typeof proof.outsideRootMount !== 'boolean' ||
      proof.outsideRootMount
    )
      throw new Error('Watched directory boundary changed');
    const identity = preciseDescriptorIdentity(current, proof.stat);
    if (
      !proof.stat.isDirectory() ||
      identity.device !== device ||
      identity.inode !== inode
    )
      return null;
    if (current !== root.fd) {
      retained = current;
      opened.pop();
    }
    let closed = false;
    return {
      fd: current,
      close() {
        if (!closed && retained !== null) fs.closeSync(retained);
        closed = true;
      },
    };
  } finally {
    let closeError;
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError) {
      if (retained !== null) {
        try {
          fs.closeSync(retained);
        } catch {}
      }
      throw closeError;
    }
  }
}
