import os from 'node:os';

// Linux inotify_event layout is native endian: int32 wd, uint32 mask/cookie/len,
// followed by a NUL-terminated raw filename and padding. The shipping images
// currently target little-endian amd64/arm64; reject other layouts explicitly.
const EVENT_HEADER = 16;
const MAX_EVENTS = 16384;
const MAX_NAME_BYTES = 255;
const IN_Q_OVERFLOW = 0x00004000;
const IN_UNMOUNT = 0x00002000;
const IN_IGNORED = 0x00008000;
const IN_DELETE_SELF = 0x00000400;
const IN_MOVE_SELF = 0x00000800;
const IN_ISDIR = 0x40000000;
const REBUILD_MASK = IN_IGNORED | IN_DELETE_SELF | IN_MOVE_SELF;

/** Decode a single bounded read without converting arbitrary filename bytes to
 * strings. The caller owns root/descriptor lookup and must reconcile a target
 * through the verified parent fd before acting on an event. Any loss of watch
 * coverage requires a full fenced recovery; it must never be ignored. */
export function parseInotifyEvents(raw) {
  if (
    os.endianness() !== 'LE' ||
    !Buffer.isBuffer(raw) ||
    raw.length === 0 ||
    raw.length > 262144
  )
    throw new Error('Invalid inotify event batch');
  const events = [];
  let offset = 0;
  while (offset < raw.length) {
    if (events.length >= MAX_EVENTS || raw.length - offset < EVENT_HEADER)
      throw new Error('Truncated or excessive inotify events');
    const wd = raw.readInt32LE(offset);
    const mask = raw.readUInt32LE(offset + 4);
    const cookie = raw.readUInt32LE(offset + 8);
    const length = raw.readUInt32LE(offset + 12);
    if (length > raw.length - offset - EVENT_HEADER || length % 4 !== 0)
      throw new Error('Malformed inotify event');
    if ((mask & IN_Q_OVERFLOW) !== 0)
      throw new Error('Inotify queue overflow: full recovery required');
    if (wd < 0 || (mask & IN_UNMOUNT) !== 0)
      throw new Error('Inotify mount or watch identity lost');
    let name = null;
    if (length) {
      const bytes = raw.subarray(
        offset + EVENT_HEADER,
        offset + EVENT_HEADER + length,
      );
      const end = bytes.indexOf(0);
      if (
        end <= 0 ||
        end > MAX_NAME_BYTES ||
        bytes.subarray(end).some((value) => value !== 0)
      )
        throw new Error('Malformed inotify filename');
      const component = bytes.subarray(0, end);
      if (
        component.includes(0x2f) ||
        (end === 1 && component[0] === 0x2e) ||
        (end === 2 && component[0] === 0x2e && component[1] === 0x2e)
      )
        throw new Error('Invalid inotify filename');
      name = Buffer.from(component);
    }
    events.push({
      wd,
      mask,
      cookie,
      name,
      directory: (mask & IN_ISDIR) !== 0,
      coverageLost: (mask & REBUILD_MASK) !== 0,
    });
    offset += EVENT_HEADER + length;
  }
  return events;
}
