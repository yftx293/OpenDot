import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const Window = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/),
    pid: z.number().int().positive().safe(),
    windowId: z.number().int().positive().safe(),
    appName: z.string().max(200),
    title: z.string().max(200),
  })
  .strict();
export type DiscoveredWindow = z.infer<typeof Window>;

/** Converts local OS identifiers into short-lived opaque model-facing handles.
 * The caller is responsible for device authorization before discovery and
 * each subsequent action; this class does not grant any access. */
export class KimiCuWindowDiscovery {
  private windows = new Map<string, DiscoveredWindow>();
  private expiresAt = 0;
  constructor(
    private readonly enumerate: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  async list(application?: string, title?: string) {
    // A failed refresh must not leave an earlier selection usable.
    this.windows.clear();
    this.expiresAt = 0;
    const windows = z
      .array(Window)
      .max(150)
      .parse(await this.enumerate());
    const filtered = windows.filter(
      (window) =>
        (!application ||
          window.appId === application ||
          window.appName
            .toLocaleLowerCase()
            .includes(application.toLocaleLowerCase())) &&
        (!title ||
          window.title.toLocaleLowerCase().includes(title.toLocaleLowerCase())),
    );
    const output = filtered.map((window) => {
      const handle = randomUUID();
      this.windows.set(handle, window);
      return { handle, appName: window.appName, title: window.title, label: `${window.appName} — ${window.title}` };
    });
    this.expiresAt = this.now() + 120_000;
    return output;
  }

  async resolve(handle: string): Promise<DiscoveredWindow> {
    z.uuid().parse(handle);
    const selected = this.windows.get(handle);
    if (!selected || this.expiresAt <= this.now())
      throw new Error('Window selection expired; list windows again');
    const current = z
      .array(Window)
      .max(150)
      .parse(await this.enumerate());
    if (this.expiresAt <= this.now()) {
      this.windows.delete(handle);
      throw new Error('Window selection expired; list windows again');
    }
    const matches = current.filter(
      (window) =>
        window.appId === selected.appId &&
        window.pid === selected.pid &&
        window.windowId === selected.windowId,
    );
    if (matches.length !== 1) {
      this.windows.delete(handle);
      throw new Error('Window changed; list windows again');
    }
    return matches[0];
  }
}
