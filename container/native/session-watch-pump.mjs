import { Worker } from 'node:worker_threads';
import { parseInotifyEvents } from './session-watch-events.mjs';

/** Bounded event pump for the descriptor-based watcher. The caller must treat
 * onFailure as fatal or
 * rebuild all watches behind a fresh, fully rescanned authority fence. */
export class NativeWatchPump {
  #worker;
  #state = new Int32Array(new SharedArrayBuffer(8));
  #stopping = false;
  #failed = false;
  #exited;
  #ready;
  #rejectReady;
  #readySeen = false;
  #heartbeatTimer;
  #stopPromise;

  constructor(fd, onEvents, onFailure) {
    if (
      !Number.isSafeInteger(fd) ||
      fd < 0 ||
      typeof onEvents !== 'function' ||
      typeof onFailure !== 'function'
    )
      throw new Error('Invalid inotify pump configuration');
    const worker = new Worker(
      new URL('./session-watch-reader.mjs', import.meta.url),
      {
        workerData: { fd, control: this.#state.buffer },
      },
    );
    this.#worker = worker;
    this.#exited = new Promise((resolve) => worker.once('exit', resolve));
    let resolveReady;
    this.#ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // A consumer may stop before awaiting readiness.
    void this.#ready.catch(() => {});
    let lastPulse = Atomics.load(this.#state, 1);
    let lastPulseAt = performance.now();
    let pendingAt;
    const fail = (error) => {
      if (this.#stopping || this.#failed) return;
      this.#failed = true;
      clearInterval(this.#heartbeatTimer);
      this.#rejectReady(error);
      Atomics.store(this.#state, 0, 2);
      Atomics.notify(this.#state, 0);
      onFailure(error);
    };
    this.#heartbeatTimer = setInterval(() => {
      if (this.#stopping || this.#failed) return;
      const now = performance.now();
      const pulse = Atomics.load(this.#state, 1);
      if (pulse !== lastPulse) {
        lastPulse = pulse;
        lastPulseAt = now;
      }
      if (now - lastPulseAt >= 10000)
        return fail(new Error('Inotify reader heartbeat expired'));
      if (Atomics.load(this.#state, 0) === 1) {
        pendingAt ??= now;
        if (now - pendingAt >= 10000)
          return fail(new Error('Inotify event batch was not acknowledged'));
      } else pendingAt = undefined;
    }, 2000);
    this.#heartbeatTimer.unref();
    worker.on('message', (message) => {
      if (this.#stopping || this.#failed) return;
      try {
        if (message?.kind === 'failure')
          throw new Error(`Inotify reader failed: ${message.code}`);
        if (message?.kind === 'ready') {
          if (this.#readySeen) throw new Error('Duplicate inotify readiness');
          this.#readySeen = true;
          resolveReady();
          return;
        }
        if (
          message?.kind !== 'events' ||
          !(message.bytes instanceof Uint8Array) ||
          Atomics.load(this.#state, 0) !== 1
        )
          throw new Error('Invalid inotify reader message');
        const events = parseInotifyEvents(Buffer.from(message.bytes));
        const result = onEvents(events);
        if (result && typeof result.then === 'function')
          throw new Error('Inotify event processing must finish synchronously');
        // A concurrent stop must never be overwritten by a late ACK.
        if (Atomics.compareExchange(this.#state, 0, 1, 0) === 1) {
          pendingAt = undefined;
          Atomics.notify(this.#state, 0);
        }
      } catch (error) {
        fail(error);
      }
    });
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (!this.#stopping) fail(new Error(`Inotify reader exited (${code})`));
    });
  }

  /** Initial events were processed through the first non-blocking empty read. */
  get ready() {
    return this.#ready;
  }

  /** Caller closes the inotify descriptor only after this resolves. */
  async stop() {
    if (!this.#stopPromise) {
      this.#stopping = true;
      clearInterval(this.#heartbeatTimer);
      this.#rejectReady(new Error('Inotify reader stopped'));
      Atomics.store(this.#state, 0, 2);
      Atomics.notify(this.#state, 0);
      this.#stopPromise = (async () => {
        let timer;
        try {
          const exited = await Promise.race([
            this.#exited.then(() => true),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); }),
          ]);
          if (!exited) {
            // Do not close the descriptor while the reader might still use it.
            // The supervisor treats this error as fatal and exits the process.
            void this.#worker.terminate().catch(() => {});
            throw new Error('Inotify reader did not stop');
          }
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    await this.#stopPromise;
  }
}
