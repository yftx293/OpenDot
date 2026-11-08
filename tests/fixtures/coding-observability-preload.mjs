import fs from 'node:fs';
import { HostObservability } from '../../dist/personal-agent/host-observability.js';
const exporter = {
  export(spans, callback) {
    for (const span of spans)
      fs.appendFileSync(
        process.env.TEST_CODING_TRACE_FILE,
        JSON.stringify({ name: span.name, attributes: span.attributes }) + '\n',
      );
    callback({ code: 0 });
  },
  async shutdown() {},
};
new HostObservability({
  publicKey: 'test-public',
  secretKey: 'test-secret',
  baseUrl: 'https://example.test/',
  installationId: 'test-installation',
  sampleRate: 1,
  exporter,
});
