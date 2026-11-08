// Synthetic test-only collector: HTTP is intercepted before any network I/O.
import fs from 'node:fs';
import { saveHostObservabilitySettings } from '../../dist/personal-agent/host-observability-config.js';

const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === 'https://127.0.0.1:9') {
    if (url.pathname !== '/api/public/scores')
      throw new Error('Unexpected synthetic collector request');
    fs.appendFileSync(
      process.env.TEST_GROUP_SCORE_FILE,
      JSON.stringify(JSON.parse(String(init?.body))) + '\n',
      { mode: 0o600 },
    );
    return new Response(JSON.stringify({ message: 'Accepted' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    throw new Error('External fixture network forbidden');
  return original(input, init);
};
saveHostObservabilitySettings({
  enabled: true,
  origin: 'https://127.0.0.1:9/',
  sampleRate: 1,
  publicKey: 'synthetic-public',
  secretKey: 'synthetic-secret',
});
