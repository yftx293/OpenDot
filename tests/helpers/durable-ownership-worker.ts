import { createRegistry } from '@earendil-works/pi-durable';
import { DurableOwnershipConflict } from '../../src/personal-agent/durable-ownership.js';
import { PiDurableRuntimeAdapter } from '../../src/personal-agent/durable-runtime.js';

async function discardActivatedAdapter() {
  const adapter = await PiDurableRuntimeAdapter.open({
    databasePath: process.argv[2],
    registry: createRegistry(),
    authorizeConversation: () => undefined,
    recordInputRequest: () => undefined,
  });
  await adapter.activate(() => undefined);
}

async function main() {
  try {
    if (process.argv[3] === 'discard') {
      // Keep the process alive independently of the discarded adapter.
      process.on('message', () => undefined);
      await discardActivatedAdapter();
      if (!globalThis.gc) throw new Error('GC injection is unavailable');
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        globalThis.gc();
      }
      process.send?.({ status: 'opened' });
      return;
    }
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath: process.argv[2],
      registry: createRegistry(),
      authorizeConversation: () => undefined,
      recordInputRequest: () => undefined,
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await adapter.close();
      if (process.connected) process.disconnect();
    };
    process.on('message', (message) => {
      if (message === 'close') void close();
    });
    process.on('disconnect', () => void close());
    process.send?.({ status: 'opened' });
  } catch (error) {
    process.send?.({
      status: error instanceof DurableOwnershipConflict ? 'owned' : 'error',
      ...(error instanceof DurableOwnershipConflict
        ? {}
        : {
            error: {
              name: error instanceof Error ? error.name : typeof error,
              message: error instanceof Error ? error.message : String(error),
              errcode: (error as { errcode?: number })?.errcode,
            },
          }),
    });
    process.exitCode = error instanceof DurableOwnershipConflict ? 2 : 1;
    if (process.connected) process.disconnect();
  }
}
void main();
