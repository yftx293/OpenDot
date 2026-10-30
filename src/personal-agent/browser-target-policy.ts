import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { z } from 'zod';

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({ action: z.literal('navigate'), url: z.string().url().max(2048) })
    .strict(),
  z
    .object({
      action: z.literal('click'),
      selector: z.string().regex(/^@e[0-9]+$/),
    })
    .strict(),
  z
    .object({
      action: z.literal('fill'),
      selector: z.string().regex(/^@e[0-9]+$/),
      value: z.string().max(4096),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof ActionSchema>;
export type BrowserTarget = Readonly<{
  session: string;
  tab: string;
  url: string;
  revision: string;
}>;

/** The trusted device wrapper must enforce these checks atomically with the
 * backend operation. A before/after URL poll alone cannot prove that the user
 * did not switch tabs or the page did not change during a click. */
export interface FencedBrowserBackend {
  observe(): Promise<{ target: BrowserTarget; text: string }>;
  executeAtTarget(input: {
    target: BrowserTarget;
    action: BrowserAction;
    allowedOrigins: readonly string[];
  }): Promise<{ target: BrowserTarget; text?: string }>;
}

function origin(raw: string): string {
  const url = new URL(raw);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Browser target is outside the declared origin policy');
  return url.origin;
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const locks = new Map<string, Promise<void>>();
export async function serial<T>(
  resource: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(resource) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => next);
  locks.set(resource, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(resource) === tail) locks.delete(resource);
  }
}

/** SQLite's OS-backed write lock fences all cooperating node processes. It
 * is held for the entire backend operation and is released by the OS on crash;
 * no timed lease can expire while an action is still running. */
export async function withDeviceResourceLock<T>(
  directory: string,
  resource: string,
  work: () => Promise<T>,
): Promise<T> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(directory) !== path.resolve(directory)
  )
    throw new Error('Device resource lock directory is not private');
  const filename = path.join(directory, `${digest(resource)}.sqlite`);
  try {
    const existing = fs.lstatSync(filename);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      (process.getuid && existing.uid !== process.getuid())
    )
      throw new Error('Device resource lock file is invalid');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const db = new Database(filename, { timeout: 0 });
  let held = false;
  try {
    const deadline = Date.now() + 10_000;
    while (!held) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        held = true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'SQLITE_BUSY'
          ) ||
          Date.now() >= deadline
        )
          throw error;
        await delay(50);
      }
    }
    return await work();
  } finally {
    try {
      if (held) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}

/** A single device-local, server-created browser session. No caller-supplied
 * device, tab, origin list or session can broaden this capability. */
export class BrowserTargetPolicy {
  private readonly allowed: readonly string[];
  private observation?: {
    target: BrowserTarget;
    token: string;
    expiresAt: number;
  };
  constructor(
    private readonly options: {
      resourceId: string;
      /** Device-local private directory, fixed by the trusted wrapper. */
      lockDirectory?: string;
      sessionId: string;
      allowedOrigins: readonly string[];
      backend: FencedBrowserBackend;
      authorize(): void;
      now?: () => number;
    },
  ) {
    if (
      !options.resourceId ||
      !options.sessionId ||
      !options.allowedOrigins.length ||
      options.allowedOrigins.length > 20
    )
      throw new Error('Explicit browser target scope required');
    this.allowed = [
      ...new Set(
        options.allowedOrigins.map((s) => {
          const url = new URL(s);
          if (url.pathname !== '/' || url.search || url.hash)
            throw new Error('Origin must not include a path');
          return origin(s);
        }),
      ),
    ].sort();
  }
  private verify(target: BrowserTarget) {
    if (
      target.session !== this.options.sessionId ||
      !target.tab ||
      !target.revision ||
      !this.allowed.includes(origin(target.url))
    )
      throw new Error('Browser target changed or is outside authorization');
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  async observe() {
    return serial(this.options.resourceId, () =>
      withDeviceResourceLock(
        this.options.lockDirectory ??
          path.join(os.homedir(), '.opendot', 'device-locks'),
        this.options.resourceId,
        async () => {
          // A failed re-observation must not leave an older approval usable.
          this.observation = undefined;
          this.options.authorize();
          const observed = await this.options.backend.observe();
          this.options.authorize();
          this.verify(observed.target);
          if (Buffer.byteLength(observed.text) > 65536)
            throw new Error('Browser observation exceeds budget');
          const target = Object.freeze({ ...observed.target });
          const token = randomUUID();
          this.observation = { target, token, expiresAt: this.now() + 30000 };
          return { token, targetDigest: digest(target), text: observed.text };
        },
      ),
    );
  }
  async execute(raw: unknown, token: string, approvedDigest: string) {
    const action = ActionSchema.parse(raw);
    return serial(this.options.resourceId, () =>
      withDeviceResourceLock(
        this.options.lockDirectory ??
          path.join(os.homedir(), '.opendot', 'device-locks'),
        this.options.resourceId,
        async () => {
          this.options.authorize();
          const observation = this.observation;
          if (
            !observation ||
            observation.token !== token ||
            observation.expiresAt <= this.now() ||
            digest({ target: observation.target, action }) !== approvedDigest
          )
            throw new Error('Browser action approval or observation changed');
          this.verify(observation.target);
          if (
            action.action === 'navigate' &&
            !this.allowed.includes(origin(action.url))
          )
            throw new Error('Browser navigation denied');
          // Consume before the external call: unknown outcomes are never retried.
          this.observation = undefined;
          const result = await this.options.backend.executeAtTarget({
            target: observation.target,
            action,
            allowedOrigins: this.allowed,
          });
          this.options.authorize();
          this.verify(result.target);
          if (
            result.text !== undefined &&
            Buffer.byteLength(result.text) > 65536
          )
            throw new Error('Browser result exceeds budget');
          return result;
        },
      ),
    );
  }
  approvalDigest(token: string, raw: unknown) {
    const action = ActionSchema.parse(raw);
    if (
      !this.observation ||
      this.observation.token !== token ||
      this.observation.expiresAt <= this.now()
    )
      throw new Error('Browser observation expired');
    return digest({ target: this.observation.target, action });
  }
}
