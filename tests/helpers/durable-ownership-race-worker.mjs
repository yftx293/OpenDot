import {
  acquireDurableDatabaseOwnership,
  DurableOwnershipConflict,
} from '../../dist/personal-agent/durable-ownership.js';
let ownership;
process.send?.({ status: 'ready' });
process.on('message', (message) => {
  if (message === 'acquire') {
    try {
      ownership = acquireDurableDatabaseOwnership(process.argv[2]);
      process.send?.({ status: 'opened' });
    } catch (error) {
      process.send?.({
        status: error instanceof DurableOwnershipConflict ? 'owned' : 'error',
      });
    }
  } else if (message === 'close') {
    ownership?.release();
    if (process.connected) process.disconnect();
  }
});
