import fs from 'node:fs';
import './mem0-product-preload.mjs';
const original = globalThis.setInterval;
globalThis.setInterval = function (callback, delay, ...args) {
  if (delay === 5000 && String(callback).includes('processFullFn')) {
    fs.writeFileSync(process.env.TEST_IPC_FALLBACK_PROBE, 'delayed');
    delay = 60000;
  }
  return original(callback, delay, ...args);
};
