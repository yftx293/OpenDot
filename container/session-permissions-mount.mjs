import fs from 'node:fs';

/** Node's Linux recursive watcher may return strings even with buffer encoding.
 * Reject lossy Unicode paths instead of guessing which filesystem entry was
 * observed. Raw Buffer events continue to support arbitrary filename bytes. */
export function watchRelativeComponents(relativeName) {
  if (typeof relativeName === 'string') {
    if (relativeName.includes('\ufffd')) return null;
    const bytes = Buffer.from(relativeName, 'utf8');
    if (bytes.toString('utf8') !== relativeName) return null;
    relativeName = bytes;
  }
  if (!Buffer.isBuffer(relativeName) || relativeName.length === 0) return null;
  if (relativeName[0] === 0x2f || relativeName.includes(0)) return null;
  const components = [];
  let start = 0;
  for (let index = 0; index <= relativeName.length; index += 1) {
    if (index !== relativeName.length && relativeName[index] !== 0x2f) continue;
    const component = relativeName.subarray(start, index);
    if (
      component.length === 0 ||
      (component.length === 1 && component[0] === 0x2e) ||
      (component.length === 2 && component[0] === 0x2e && component[1] === 0x2e)
    )
      return null;
    components.push(Buffer.from(component));
    start = index + 1;
  }
  return components;
}

/** Preserve root and component boundaries, including arbitrary filename bytes.
 * Joining raw components can coalesce unrelated directories (a/bc and ab/c)
 * and accidentally drop a required deferred rescan. */
export function watchRescanKey(rootPath, components) {
  return JSON.stringify([
    rootPath,
    ...components.map((part) => part.toString('hex')),
  ]);
}

/** Repeated watch loss means a successful re-registration is not a stable
 * recovery. Bound retries across successful re-registrations as well as across
 * failed scans, so a broken watcher cannot silently flap forever. */
export function recordWatchRecovery(history, now, windowMs, maxLosses) {
  const recent = history.filter((at) => now >= at && now - at < windowMs);
  recent.push(now);
  return { recent, exhausted: recent.length >= maxLosses };
}

export function parseDescriptorMountId(fdInfo) {
  if (typeof fdInfo !== 'string') {
    throw new Error('descriptor mount metadata is not text');
  }
  const matches = [...fdInfo.matchAll(/^mnt_id:\s+([0-9]+)\s*$/gm)];
  if (matches.length !== 1) {
    throw new Error('descriptor mount metadata has no unique mnt_id');
  }
  const mountId = Number(matches[0][1]);
  if (!Number.isSafeInteger(mountId) || mountId <= 0) {
    throw new Error('descriptor mount metadata has an invalid mnt_id');
  }
  return mountId;
}

export function readDescriptorMountId(fd, readFile = fs.readFileSync) {
  const fdInfo = readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
  return parseDescriptorMountId(fdInfo);
}

/** Node's numeric Stats can round large device or inode values. Preserve exact
 * descriptor identity for cache/watch keys rather than comparing rounded IDs. */
export function preciseDescriptorIdentity(fd, stat, io = fs) {
  let { dev, ino } = stat;
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
    const precise = io.fstatSync(fd, { bigint: true });
    dev = precise.dev;
    ino = precise.ino;
    if (typeof dev !== 'bigint' || typeof ino !== 'bigint')
      throw new Error('Precise descriptor identity unavailable');
  }
  if (
    (typeof dev !== 'bigint' && (!Number.isSafeInteger(dev) || dev < 0)) ||
    (typeof ino !== 'bigint' && (!Number.isSafeInteger(ino) || ino < 1)) ||
    (typeof dev === 'bigint' && dev < 0n) ||
    (typeof ino === 'bigint' && ino < 1n)
  )
    throw new Error('Invalid descriptor identity');
  return { device: String(dev), inode: String(ino) };
}

/** A virtualized bind can apply chown while reporting the same host-mapped IDs.
 * Remember that successful mapping per inode so our own watch events do not
 * repeatedly chown/chmod it. Mode changes are still reconciled on every event.
 * Other identity modes require ordinary numeric ownership, without this cache.
 */
export function reconcileDescriptorOwnership(
  fd,
  stat,
  uid,
  gid,
  root,
  io = fs,
) {
  if (stat.uid === uid && stat.gid === gid) return false;
  const mapped = root.virtualizedOwnership;
  const identity = mapped ? preciseDescriptorIdentity(fd, stat, io) : undefined;
  const key = identity
    ? `${identity.device}:${identity.inode}:${uid}:${gid}`
    : '';
  const observed = `${stat.uid}:${stat.gid}`;
  root.virtualizedOwnershipSeen?.add(key);
  if (mapped?.get(key) === observed) return false;
  io.fchownSync(fd, uid, gid);
  if (mapped) {
    const after = io.fstatSync(fd);
    if (after.uid === stat.uid && after.gid === stat.gid) {
      mapped.set(key, observed);
    } else {
      mapped.delete(key);
    }
  }
  return true;
}
