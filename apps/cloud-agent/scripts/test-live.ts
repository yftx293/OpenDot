import { setTimeout as delay } from 'node:timers/promises';
import { signedRequest, digest, type SessionBinding } from '../src/protocol';
const required = [
  'MINICLAW_CLOUD_LIVE_URL',
  'MINICLAW_CLOUD_SHARED_SECRET',
  'MINICLAW_ZEN_MODEL',
  'MINICLAW_CLOUD_LIVE_PROVIDER_ID',
] as const;
const missing = required.filter((name) => !process.env[name]?.trim());
if (
  missing.length ||
  process.env.MINICLAW_CLOUD_STAGING_AUTHORIZED !== 'true'
) {
  console.log(
    JSON.stringify({
      status: 'pending',
      reason: missing.length
        ? 'secure_environment_binding_missing'
        : 'staging_execution_not_authorized',
      missing,
    }),
  );
  process.exitCode = 2;
} else {
  try {
    const url = new URL(process.env.MINICLAW_CLOUD_LIVE_URL!);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Invalid staging endpoint');
    const secret = process.env.MINICLAW_CLOUD_SHARED_SECRET!;
    const sessionId = crypto.randomUUID();
    const nonce = `CLOUD_LIVE_${crypto.randomUUID()}`;
    const binding: SessionBinding = {
      version: 1,
      owner_user_id: 'miniclaw-authorized-cloud-check',
      workspace_jid: 'web:miniclaw-cloud-check',
      session_id: sessionId,
      runtime_id: crypto.randomUUID(),
      config_fingerprint: await digest(
        JSON.stringify({
          provider: process.env.MINICLAW_CLOUD_LIVE_PROVIDER_ID,
          model: process.env.MINICLAW_ZEN_MODEL,
        }),
      ),
      provider_id: process.env.MINICLAW_CLOUD_LIVE_PROVIDER_ID!,
      model_id: process.env.MINICLAW_ZEN_MODEL!,
      instructions:
        'This is an explicitly authorized isolated staging check. Use only the declared read-only tool. Do not request other data or external effects.',
      max_model_steps: 6,
      deadline_at: Date.now() + 300000,
    };
    const base = `${url.origin}/internal/cloud-sessions/${sessionId}`;
    async function call(endpoint: string, method = 'GET', body?: unknown) {
      const request = await signedRequest(
        secret,
        binding,
        endpoint,
        method,
        body === undefined ? '' : JSON.stringify(body),
      );
      const response = await fetch(request, {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Cloud check request failed');
      }
      return response.json() as Promise<any>;
    }
    async function complete(requestId: string) {
      const until = Date.now() + 90000;
      while (Date.now() < until) {
        const snapshot = await call(base);
        const input = snapshot.inputs.find(
          (item: { id: string }) => item.id === requestId,
        );
        if (input?.status === 'unanswered')
          throw new Error('Configured model did not answer');
        if (input?.status === 'done' && input.answer_entry_id) return snapshot;
        await delay(500);
      }
      throw new Error('Cloud execution did not complete');
    }
    const created = await call(
      `${url.origin}/internal/cloud-sessions`,
      'POST',
      binding,
    );
    const first = crypto.randomUUID();
    await call(`${base}/messages`, 'POST', {
      request_id: first,
      content: `Use inspect_text on exactly ${nonce}, then report its SHA256.`,
    });
    const before = await complete(first);
    const hash = await digest(nonce);
    if (
      !before.view.entries.some(
        (entry: any) =>
          entry.kind === 'pi.tool-result' &&
          JSON.stringify(entry.model).includes(hash),
      )
    )
      throw new Error('Required actual tool result missing');
    const future = crypto.randomUUID(),
      execution = crypto.randomUUID(),
      notBefore = Date.now() + 45000;
    const wake = {
      execution_id: execution,
      not_before: notBefore,
      input: {
        request_id: future,
        content: 'Return CLOUD_ALARM_DONE without any tool calls.',
      },
    };
    await call(`${base}/wake`, 'POST', wake);
    // No open client connection, SSE watch or polling during the future wait.
    await delay(46000);
    const after = await complete(future);
    const futureReceipt = after.inputs.find(
      (input: any) => input.id === future,
    );
    const futureAnswer = after.view.entries.find(
      (entry: any) => entry.id === futureReceipt.answer_entry_id,
    );
    if (!JSON.stringify(futureAnswer?.model).includes('CLOUD_ALARM_DONE'))
      throw new Error('Original alarm answer missing');
    await call(`${base}/wake`, 'POST', wake);
    if (
      after.object_id !== created.object_id ||
      after.inputs.filter((item: { id: string }) => item.id === future)
        .length !== 1
    )
      throw new Error('Cloud identity or receipt mismatch');
    console.log(
      JSON.stringify({
        status: 'passed',
        scope: 'authorized-staging-poc',
        session_id: sessionId,
        object_id: created.object_id,
        tool_result_verified: true,
        alarm_result_verified: true,
        instance_reinitialized: before.epoch !== after.epoch,
        hibernation_reason:
          'platform lifecycle classification requires trace/metrics; reinitialization alone is not proof',
        formal_product_integration: false,
      }),
    );
  } catch {
    console.log(
      JSON.stringify({
        status: 'failed',
        reason: 'cloud_live_acceptance_failed',
        raw_errors_suppressed: true,
      }),
    );
    process.exitCode = 1;
  }
}
