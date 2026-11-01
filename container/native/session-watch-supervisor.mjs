import fs from 'node:fs';
import { NativeWatchPump } from './session-watch-pump.mjs';
import { PendingDirectoryChecks } from './session-watch-pending.mjs';
import { reconcileWatchEvents } from './session-watch-reconcile.mjs';
import { scanAndWatchRoots } from './session-watch-tree.mjs';

/** Lifecycle for descriptor-bound non-recursive watches. The caller supplies
 * existing root descriptors and the existing descriptor-based normalizer. */
export class NativeWatchSupervisor {
  #current = null;
  #building = null;
  #stopped = false;
  #failed = false;
  #busy = false;
  #dirty = false;
  #scheduled = false;
  #timer;
  #operation = null;

  constructor(native, roots, normalize, onFatal, options = {}) {
    if (
      !native ||
      !Array.isArray(roots) ||
      !roots.length ||
      typeof normalize !== 'function' ||
      typeof onFatal !== 'function'
    )
      throw new Error('Invalid permission watch supervisor');
    this.native = native;
    this.roots = roots;
    this.normalize = normalize;
    this.onFatal = onFatal;
    this.scanOptions = options.scanOptions ?? {};
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10000;
    this.rescanMs = options.rescanMs ?? 30000;
    if (
      !Number.isSafeInteger(this.readyTimeoutMs) ||
      this.readyTimeoutMs < 1 ||
      !Number.isSafeInteger(this.rescanMs) ||
      this.rescanMs < 1000
    )
      throw new Error('Invalid permission watch timing');
  }

  #fatal(error) {
    if (this.#stopped || this.#failed) return;
    this.#failed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#current?.pending.close();
    this.#building?.pending.close();
    // The owner must stop the container; do not leave it running while a
    // failed watcher attempts an unprotected asynchronous recovery.
    this.onFatal(error);
  }

  #requestRebuild() {
    if (this.#failed || this.#stopped) return;
    this.#dirty = true;
    if (this.#busy || this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (this.#failed || this.#stopped) return;
      void this.#runReplace().catch((error) => this.#fatal(error));
    });
  }

  #runReplace() {
    const operation = this.#replace();
    this.#operation = operation;
    void operation
      .finally(() => {
        if (this.#operation === operation) this.#operation = null;
      })
      .catch(() => {});
    return operation;
  }

  #create() {
    const fd = this.native.createInotify();
    if (!Number.isSafeInteger(fd) || fd < 0)
      throw new Error('Invalid inotify descriptor');
    let tree, pending, pump;
    const generation = { fd, tree: null, pending: null, pump: null };
    try {
      tree = scanAndWatchRoots(
        this.native,
        fd,
        this.roots,
        this.normalize,
        this.scanOptions,
      );
      generation.tree = tree;
      pending = new PendingDirectoryChecks(
        this.native,
        this.normalize,
        () => this.#requestRebuild(),
        (error) => this.#fatal(error),
      );
      generation.pending = pending;
      pump = new NativeWatchPump(
        fd,
        (events) => {
          if (this.#failed || this.#stopped || generation.retired) return;
          const result = reconcileWatchEvents(
            this.native,
            tree.watches,
            events,
            this.normalize,
          );
          for (const item of result.pending) pending.schedule(item);
          if (result.rebuild) this.#requestRebuild();
        },
        (error) => this.#fatal(error),
      );
      generation.pump = pump;
      return generation;
    } catch (error) {
      pending?.close();
      tree?.close();
      fs.closeSync(fd);
      throw error;
    }
  }

  async #dispose(generation) {
    if (!generation) return;
    generation.pending.close();
    await generation.pump.stop();
    generation.tree.close();
    fs.closeSync(generation.fd);
  }

  async #waitReady(generation) {
    let timer;
    try {
      await Promise.race([
        (async () => {
          await generation.pump.ready;
          await generation.pending.whenIdle();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Permission watch readiness timed out')),
            this.readyTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #replace() {
    if (this.#busy || this.#failed || this.#stopped) return;
    this.#busy = true;
    this.#dirty = false;
    let candidate;
    let attempts = 0;
    try {
      for (;;) {
        // Ordinary directory activity can legitimately require many successful
        // rebuilds. Limit only a single replacement that never stabilizes.
        if (++attempts > 8)
          throw new Error('Permission watch replacement did not stabilize');
        this.#dirty = false;
        try {
          candidate = this.#create();
        } catch (error) {
          // A directory can be removed after it is opened but before its
          // watch or enumeration is installed. Start a complete fresh scan;
          // never publish the partial tree or stop the previous generation.
          // All other errors, and repeated instability, remain fatal.
          if (error?.code !== 'ENOENT' && error?.code !== 'ESTALE') throw error;
          if (attempts >= 8) throw error;
          await new Promise((resolve) => setImmediate(resolve));
          if (this.#failed || this.#stopped) return;
          continue;
        }
        this.#building = candidate;
        await this.#waitReady(candidate);
        if (this.#failed || this.#stopped) return;
        if (this.#dirty) {
          // A persistent directory or moved watched inode was observed during
          // the scan. Do not publish this incomplete generation as ready.
          candidate.retired = true;
          await this.#dispose(candidate);
          candidate = null;
          this.#building = null;
          continue;
        }
        const old = this.#current;
        this.#current = candidate;
        this.#building = null;
        candidate = null;
        // Old watches remain alive until the new scan and initial event drain
        // have completed. Its callbacks are stopped before descriptors close.
        if (old) old.retired = true;
        await this.#dispose(old);
        break;
      }
    } finally {
      if (candidate) await this.#dispose(candidate);
      this.#building = null;
      this.#busy = false;
      if (this.#dirty && !this.#failed && !this.#stopped)
        this.#requestRebuild();
    }
  }

  async start() {
    if (this.#current || this.#busy || this.#failed || this.#stopped)
      throw new Error('Permission watch supervisor cannot start');
    try {
      await this.#runReplace();
      if (!this.#current || this.#failed || this.#stopped)
        throw new Error('Permission watch did not reach readiness');
      this.#timer = setInterval(() => this.#requestRebuild(), this.rescanMs);
      this.#timer.unref();
    } catch (error) {
      this.#fatal(error);
      throw error;
    }
  }

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    // Stop the candidate reader so readiness waits end, then wait for the
    // in-progress replacement to release its descriptors before returning.
    const building = this.#building;
    if (building) await building.pump.stop();
    const operation = this.#operation;
    if (operation) {
      try {
        await operation;
      } catch (error) {
        // Stopping a candidate before its first drain rejects readiness. Any
        // other failure, especially a reader that could not stop, must reach
        // the owner instead of allowing a successful final scan and exit.
        if (!building || !(error instanceof Error) || error.message !== 'Inotify reader stopped')
          throw error;
      }
    }
    const current = this.#current;
    this.#current = null;
    if (current) current.retired = true;
    await this.#dispose(current);
  }
}
