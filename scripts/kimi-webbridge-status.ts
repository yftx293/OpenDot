import { inspectKimiWebBridge } from '../src/personal-agent/kimi-readiness.js';

// Local diagnostic only: never starts, installs, updates or restarts Kimi.
process.stdout.write(`${JSON.stringify(await inspectKimiWebBridge())}\n`);
