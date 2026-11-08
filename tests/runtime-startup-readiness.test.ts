import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
test('Web and authenticated controls become available while durable recovery is held', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-readiness-'));
  const marker = path.join(root, 'recovering'),
    release = path.join(root, 'release'),
    preload = path.join(root, 'hold.mjs');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs'; import {setTimeout as delay} from 'node:timers/promises'; import {ProductRuntimeService} from ${JSON.stringify(pathToFileURL(path.resolve('dist/personal-agent/product-runtime.js')).href)}; const original=ProductRuntimeService.prototype.recover; ProductRuntimeService.prototype.recover=async function(){fs.writeFileSync(${JSON.stringify(marker)},'held'); while(!fs.existsSync(${JSON.stringify(release)})) await delay(50); return original.call(this);};`,
  );
  let fixture: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  try {
    fixture = await botHandoffHttpFixture(preload, {}, 120_000);
    await waitFor(() => fs.existsSync(marker));
    expect((await fixture.call('/api/auth/me')).status).toBe(200);
    expect(fs.existsSync(release)).toBe(false);
  } finally {
    fs.writeFileSync(release, 'continue');
    await fixture?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  // This proof imports the real recovery graph in its preload before main.
  // Keep cold module loading separate from the unchanged 30-second assertions.
}, 150000);
