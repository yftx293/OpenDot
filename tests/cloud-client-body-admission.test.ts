import { afterEach, expect, test, vi } from 'vitest';
import type { ProductInput } from '../src/personal-agent/product-runtime-store.js';

const mocks = vi.hoisted(() => ({ submitted: vi.fn(), member: vi.fn() }));
vi.mock('../src/personal-agent/product-runtime-store.js', () => ({
  getCloudPlacement: () => ({
    gateway_origin: 'https://worker.example.test',
    binding_json: JSON.stringify({
      owner_user_id: 'owner',
      workspace_jid: 'web:owner',
      session_id: '11111111-1111-4111-8111-111111111111',
      runtime_id: '22222222-2222-4222-8222-222222222222',
      config_fingerprint: 'a'.repeat(64),
    }),
  }),
  markProductInputSubmitted: mocks.submitted,
}));
vi.mock('../src/bot-groups/member-inbox-store.js', () => ({
  memberCloudExecution: mocks.member,
}));
const { CloudSessionClient, assertCloudInputFits } =
  await import('../src/personal-agent/cloud-client.js');
const { CLOUD_MAX_BODY_BYTES } =
  await import('../src/personal-agent/cloud-wire.js');

function input(content: string): ProductInput {
  return {
    id: 'input',
    session_id: '11111111-1111-4111-8111-111111111111',
    request_id: 'request',
    payload_digest: 'a'.repeat(64),
    payload: JSON.stringify({ content, followUpBehavior: 'queue' }),
  } as ProductInput;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  mocks.submitted.mockReset();
  mocks.member.mockReset();
});

test('rejects a valid-length message whose JSON escapes exceed the Worker limit before any remote call', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  const client = new CloudSessionClient(() => {});
  const content = '\u0000'.repeat(32768);
  expect(content.length).toBe(32768);
  await expect(client.submit(input(content))).rejects.toMatchObject({
    status: 413,
    code: 'CLOUD_REQUEST_TOO_LARGE',
  });
  expect(request).not.toHaveBeenCalled();
  expect(mocks.submitted).not.toHaveBeenCalled();
});

test('allows a serialized message at the exact byte limit and records its receipt', async () => {
  vi.stubEnv(
    'MINICLAW_CLOUD_SHARED_SECRET',
    'synthetic-cloud-secret-at-least-32-bytes',
  );
  let wireBytes = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      wireBytes = Buffer.byteLength(await request.text(), 'utf8');
      return Response.json({
        receipt: {
          operationId: 'request',
          request_id: 'request',
          submission_id: 7,
        },
      });
    }),
  );
  const overhead = Buffer.byteLength(
    JSON.stringify({
      request_id: 'request',
      content: '',
      when_busy: 'followUp',
      product_receipt_digest: 'a'.repeat(64),
    }),
  );
  const client = new CloudSessionClient(() => {});
  await expect(
    client.submit(input('x'.repeat(CLOUD_MAX_BODY_BYTES - overhead))),
  ).resolves.toBe(7);
  expect(wireBytes).toBe(CLOUD_MAX_BODY_BYTES);
  expect(mocks.submitted).toHaveBeenCalledWith('input', 7);
});

test('pre-admission size includes the exact member and Goal execution envelope', async () => {
  const member = {
    run_id: 'r'.repeat(32),
    tool_capabilities: ['inspect_text'],
    extra: 'm'.repeat(500),
  };
  mocks.member.mockReturnValue(member);
  const execution = {
    goalId: 'g'.repeat(36),
    runId: 'r'.repeat(36),
    contextDigest: 'd'.repeat(64),
  };
  const payload = {
    sender: 'owner',
    senderName: 'Owner',
    followUpBehavior: 'queue' as const,
    content: '',
    execution,
  };
  const overhead = Buffer.byteLength(
    JSON.stringify({
      request_id: 'request',
      content: '',
      when_busy: 'followUp',
      product_receipt_digest: 'a'.repeat(64),
      member,
      execution: {
        goal_id: execution.goalId,
        run_id: execution.runId,
        context_digest: execution.contextDigest,
      },
    }),
  );
  payload.content = 'x'.repeat(CLOUD_MAX_BODY_BYTES - overhead);
  expect(() =>
    assertCloudInputFits('session', 'request', payload),
  ).not.toThrow();
  payload.content += 'x';
  expect(() => assertCloudInputFits('session', 'request', payload)).toThrow(
    'CLOUD_REQUEST_TOO_LARGE',
  );
});
