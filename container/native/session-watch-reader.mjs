import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

// Private worker in the root watcher process. The inotify descriptor is
// non-blocking and shared between threads; this worker never opens paths.
// At most one batch can be outstanding. Kernel queue overflow is reported by
// the event decoder instead of allowing an unbounded JS message backlog.
if (
  !parentPort ||
  !Number.isSafeInteger(workerData?.fd) ||
  workerData.fd < 0 ||
  !(workerData.control instanceof SharedArrayBuffer) ||
  workerData.control.byteLength !== 8
)
  throw new Error('Invalid inotify reader configuration');
const state = new Int32Array(workerData.control);
const batch = Buffer.allocUnsafe(262144);
let initialDrainComplete = false;
let lastPulse = 0;
try {
  while (Atomics.load(state, 0) !== 2) {
    const now = performance.now();
    if (now - lastPulse >= 500) {
      Atomics.add(state, 1, 1);
      lastPulse = now;
    }
    if (Atomics.load(state, 0) === 1) {
      Atomics.wait(state, 0, 1, 1000);
      continue;
    }
    let count;
    try {
      count = fs.readSync(workerData.fd, batch, 0, batch.length, null);
    } catch (error) {
      if (error?.code === 'EINTR') continue;
      if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') {
        if (!initialDrainComplete) {
          initialDrainComplete = true;
          parentPort.postMessage({ kind: 'ready' });
        }
        Atomics.wait(state, 0, 0, 25);
        continue;
      }
      throw error;
    }
    if (count <= 0) throw new Error('Inotify descriptor closed');
    const bytes = Uint8Array.from(batch.subarray(0, count));
    const prior = Atomics.compareExchange(state, 0, 0, 1);
    if (prior === 2) break;
    if (prior !== 0) throw new Error('Invalid inotify reader state');
    parentPort.postMessage({ kind: 'events', bytes }, [bytes.buffer]);
  }
} catch (error) {
  parentPort.postMessage({
    kind: 'failure',
    code: typeof error?.code === 'string' ? error.code : 'READER_FAILED',
  });
  process.exitCode = 1;
} finally {
  // No messages are received by this worker. Close its port explicitly so
  // supervisor shutdown cannot wait indefinitely on a retained MessagePort.
  parentPort.close();
}
