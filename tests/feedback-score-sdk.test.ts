import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { expect, test, vi } from 'vitest';
import { HostObservability } from '../src/personal-agent/host-observability.js';

test('official score SDK sends only an approved score reference and reports ambiguous delivery', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ message: 'Accepted' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  const tracer = new HostObservability({
    publicKey: 'fixture-public',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: new InMemorySpanExporter(),
  });
  const input = {
    feedback_id: randomUUID(),
    project_ref: tracer.projectRef,
    trace_id: 'b'.repeat(32),
    timestamp: new Date().toISOString(),
    score: 1 as const,
    version: 1,
  };
  try {
    expect(await tracer.sendFeedbackScore(input)).toBe('accepted');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('/api/public/scores');
    const serialized = JSON.stringify(requests[0].body);
    expect(serialized).toContain(input.trace_id);
    expect(serialized).toContain(input.feedback_id);
    expect(serialized).not.toContain('fixture-secret');
    fetchMock.mockRejectedValueOnce(
      new Error('synthetic lost acknowledgement'),
    );
    expect(await tracer.sendFeedbackScore(input)).toBe('uncertain');
    expect(
      await tracer.sendFeedbackScore({ ...input, project_ref: 'c'.repeat(64) }),
    ).toBe('uncertain');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    await tracer.close();
    vi.unstubAllGlobals();
  }
});
