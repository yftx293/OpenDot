import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serial, withDeviceResourceLock } from './browser-target-policy.js';

const Target = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    pid: z.number().int().positive(),
    windowId: z.number().int().positive(),
    snapshotId: z.string().min(1).max(256),
  })
  .strict();
const Action = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('click'),
      index: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_value'),
      index: z.number().int().nonnegative(),
      value: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      action: z.literal('type_text'),
      index: z.number().int().nonnegative(),
      text: z.string().max(4096),
      clear: z.boolean(),
      submit: z.boolean(),
    })
    .strict(),
]);
export type DesktopTarget = z.infer<typeof Target>;
export type DesktopAction = z.infer<typeof Action>;
/** The implementation must bind the actual app, PID, window and native
 * observation identity inside the backend operation, rejecting stale targets. */
export type DesktopScreenshot = {
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg';
  data: string;
};
export interface FencedDesktopBackend {
  observeScreenshot?(): Promise<{
    target: DesktopTarget;
    text: string;
    image: DesktopScreenshot;
  }>;
  observe(): Promise<{ target: DesktopTarget; text: string }>;
  executeAtTarget(input: {
    target: DesktopTarget;
    action: DesktopAction;
  }): Promise<{ target: DesktopTarget; text?: string }>;
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Local policy; only a trusted backend with atomic native target checks may
 * implement the interface. No app launch, raw JS or coordinate actions. */
export class KimiDesktopTargetPolicy {
  private observation?: {
    target: DesktopTarget;
    token: string;
    expiresAt: number;
  };
  private readonly allowed: Set<string>;
  constructor(
    private readonly options: {
      resourceId: string;
      lockDirectory: string;
      allowedApps: readonly string[];
      backend: FencedDesktopBackend;
      authorize(): void;
      now?: () => number;
      observationTtlMs?: number;
    },
  ) {
    if (
      !options.resourceId ||
      !options.allowedApps.length ||
      options.allowedApps.length > 20
    )
      throw new Error('Explicit desktop target scope required');
    for (const app of options.allowedApps) Target.shape.appId.parse(app);
    if (
      options.observationTtlMs !== undefined &&
      (!Number.isSafeInteger(options.observationTtlMs) ||
        options.observationTtlMs < 1000 ||
        options.observationTtlMs > 120000)
    )
      throw new Error('Invalid desktop observation lifetime');
    this.allowed = new Set(options.allowedApps);
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private verify(raw: unknown) {
    const target = Target.parse(raw);
    if (!this.allowed.has(target.appId))
      throw new Error('Desktop app outside authorization');
    return target;
  }
  private locked<T>(work: () => Promise<T>) {
    return serial(this.options.resourceId, () =>
      withDeviceResourceLock(
        this.options.lockDirectory,
        this.options.resourceId,
        work,
      ),
    );
  }
  async observe(includeScreenshot = false) {
    return this.locked(async () => {
      // A failed re-observation must invalidate the previous snapshot.
      this.observation = undefined;
      this.options.authorize();
      const backend = this.options.backend;
      if (includeScreenshot && !backend.observeScreenshot)
        throw new Error('Desktop screenshot unavailable');
      const value = includeScreenshot
        ? await backend.observeScreenshot!()
        : await backend.observe();
      this.options.authorize();
      const target = Object.freeze(this.verify(value.target));
      if (
        typeof value.text !== 'string' ||
        Buffer.byteLength(value.text) > 65536
      )
        throw new Error('Desktop observation exceeds budget');
      const token = randomUUID();
      this.observation = {
        target,
        token,
        expiresAt: this.now() + (this.options.observationTtlMs ?? 30000),
      };
      return {
        token,
        targetDigest: digest(target),
        text: value.text,
        ...('image' in value ? { image: value.image } : {}),
      };
    });
  }
  approvalDigest(token: string, raw: unknown) {
    const action = Action.parse(raw);
    const o = this.observation;
    if (!o || o.token !== token || o.expiresAt <= this.now())
      throw new Error('Desktop observation expired');
    return digest({ target: o.target, action });
  }
  async execute(raw: unknown, token: string, approvedDigest: string) {
    const action = Action.parse(raw);
    return this.locked(async () => {
      this.options.authorize();
      const o = this.observation;
      if (
        !o ||
        o.token !== token ||
        o.expiresAt <= this.now() ||
        digest({ target: o.target, action }) !== approvedDigest
      )
        throw new Error('Desktop approval or observation changed');
      this.verify(o.target);
      this.observation = undefined;
      const result = await this.options.backend.executeAtTarget({
        target: o.target,
        action,
      });
      this.options.authorize();
      const actual = this.verify(result.target);
      if (digest(actual) !== digest(o.target))
        throw new Error('Desktop target changed');
      if (
        result.text !== undefined &&
        (typeof result.text !== 'string' ||
          Buffer.byteLength(result.text) > 65536)
      )
        throw new Error('Desktop result exceeds budget');
      return result;
    });
  }
}
