import { inspectKimiComputerUse } from '../src/personal-agent/kimi-readiness.js';

// Local diagnostic only: never starts a service or requests OS permissions.
process.stdout.write(`${JSON.stringify(await inspectKimiComputerUse())}\n`);
