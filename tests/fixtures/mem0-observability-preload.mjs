// Synthetic Mem0 and loopback OTLP collector; no external service is called.
import './mem0-product-preload.mjs';
import fs from 'node:fs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HostObservability } from '../../dist/personal-agent/host-observability.js';
const endpoint = new URL(process.env.TEST_OTLP_URL);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
  throw new Error('OTLP fixture must use loopback');
new HostObservability({
  publicKey: 'test-public',
  secretKey: 'test-secret',
  baseUrl: 'https://example.test/',
  installationId: 'test-installation',
  sampleRate: 1,
  exporter: new OTLPTraceExporter({ url: endpoint.href, timeoutMillis: 2000 }),
});
if (process.env.TEST_FAIL_OBSERVATION_SOURCE_ONCE === 'true') {
  const { PiDurableRuntimeAdapter } =
    await import('../../dist/personal-agent/durable-runtime.js');
  const original = PiDurableRuntimeAdapter.prototype.productGenerationSource;
  let failed = false;
  PiDurableRuntimeAdapter.prototype.productGenerationSource = function (...args) {
    if (!failed) {
      failed = true;
      if (process.env.TEST_OBSERVATION_FAILURE_MARKER)
        fs.writeFileSync(process.env.TEST_OBSERVATION_FAILURE_MARKER, 'injected');
      return Promise.reject(new Error('synthetic observation source failure'));
    }
    return original.apply(this, args);
  };
}
const fixtureFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (
    String(url).includes('api.mem0.ai/v3/memories/search/') &&
    String(options?.body).includes('SYNTHETIC_NO_RECALL')
  )
    return Response.json({ results: [] });
  return fixtureFetch(url, options);
};
