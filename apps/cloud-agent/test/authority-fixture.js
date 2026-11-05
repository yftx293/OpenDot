// Policy fixture only. Product signature/ACL/encrypted Provider enforcement is
// exercised by tests/cloud-authority.test.ts against the actual Node authority.
let allowed = true;
let executionAllowed = true;
let policies = 0;
let models = 0;
let leakedKey = false;
let loseResultAck = false;
let resultAttempts = 0;
const resultAttemptsBySession = new Map();
const delivered = new Map();
let memoryReads = [];
let holdMemory = false;
let memoryAllowed = true;
const artifacts = new Map();
const artifactEffects = new Set();
let artifactRequests = [];
let loseArtifactAck = false;
const activeRuns = new Map();
const stopFences = new Map();
const handoffStopFences = new Map();
const handoffProgress = new Map();
let loseProgressAck = false;
let denyProgress = false;
let progressAttempts = 0;
let modelExecutions = [];
let holdNativePolicy = false;
let heldPolicies = 0;
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture/reset') {
      allowed = true;
      executionAllowed = true;
      policies = 0;
      models = 0;
      leakedKey = false;
      loseResultAck = false;
      resultAttempts = 0;
      resultAttemptsBySession.clear();
      delivered.clear();
      memoryReads = [];
      holdMemory = false;
      memoryAllowed = true;
      artifacts.clear();
      artifactEffects.clear();
      artifactRequests = [];
      loseArtifactAck = false;
      activeRuns.clear();
      stopFences.clear();
      handoffStopFences.clear();
      handoffProgress.clear();
      loseProgressAck = false;
      denyProgress = false;
      progressAttempts = 0;
      modelExecutions = [];
      holdNativePolicy = false;
      heldPolicies = 0;
      return Response.json({ ok: true });
    }
    if (
      path === '/fixture/revoke-execution' ||
      path === '/fixture/allow-execution'
    ) {
      executionAllowed = path === '/fixture/allow-execution';
      return Response.json({ ok: true });
    }
    if (path === '/fixture/revoke') {
      allowed = false;
      return Response.json({ ok: true });
    }
    if (path === '/fixture/counts') {
      const session = new URL(request.url).searchParams.get('session');
      return Response.json({
        policies,
        models,
        leakedKey,
        resultAttempts: session
          ? (resultAttemptsBySession.get(session) ?? 0)
          : resultAttempts,
        deliveries: session
          ? [...delivered.values()].filter((owner) => owner === session).length
          : delivered.size,
        memoryReads,
        artifactRequests,
        artifactEffects: artifactEffects.size,
        modelExecutions,
        heldPolicies,
      });
    }
    if (path === '/fixture/progress-counts')
      return Response.json({
        attempts: progressAttempts,
        frames: [...handoffProgress.values()],
      });
    if (path === '/fixture/lose-progress-ack') {
      const raw = await request.text();
      loseProgressAck = raw ? JSON.parse(raw) : {};
      return Response.json({ ok: true });
    }
    if (
      path === '/fixture/deny-progress' ||
      path === '/fixture/allow-progress'
    ) {
      denyProgress = path === '/fixture/deny-progress';
      return Response.json({ ok: true });
    }
    if (path === '/fixture/handoff-stop') {
      const value = await request.json();
      handoffStopFences.set(value.session_id, value);
      return Response.json({ ok: true });
    }
    if (path === '/fixture/execution') {
      const body = await request.json();
      activeRuns.set(body.session_id, body.run_id);
      stopFences.set(
        body.session_id,
        body.fence ?? {
          lease_owner: 'scheduler',
          lease_token: 1,
          goal_revision: 1,
          mode: 'suspended',
        },
      );
      return Response.json({ ok: true });
    }
    if (path === '/fixture/lose-result-ack') {
      loseResultAck = true;
      return Response.json({ ok: true });
    }
    if (path === '/fixture/hold-memory') {
      holdMemory = true;
      return Response.json({ ok: true });
    }
    if (path === '/fixture/revoke-memory') {
      memoryAllowed = false;
      return Response.json({ ok: true });
    }
    if (
      path === '/fixture/approve-artifacts' ||
      path === '/fixture/deny-artifacts'
    ) {
      for (const row of artifacts.values())
        if (row.state === 'pending')
          row.state = path.includes('approve-') ? 'approved' : 'denied';
      return Response.json({ ok: true });
    }
    if (path === '/fixture/lose-artifact-ack') {
      loseArtifactAck = true;
      return Response.json({ ok: true });
    }
    const header = request.headers.get('Authorization') ?? '';
    if (!header.startsWith('MiniClawCloud '))
      return new Response(null, { status: 401 });
    if (header.includes('fixture-model-key')) leakedKey = true;
    if (!allowed) return new Response(null, { status: 409 });
    const claims = JSON.parse(
      atob(
        header
          .slice(14)
          .split('.')[0]
          .replaceAll('-', '+')
          .replaceAll('_', '/'),
      ),
    );
    if (path.endsWith('/stop-policy')) {
      const { fence, execution } = await request.json();
      const current =
        fence.kind === 'handoff'
          ? handoffStopFences.get(claims.session_id)
          : stopFences.get(claims.session_id);
      if (fence.kind === 'handoff') {
        if (
          !current ||
          execution ||
          fence.handoff_id !== current.handoff_id ||
          fence.handoff_revision !== current.handoff_revision
        )
          return new Response(null, { status: 409 });
      } else if (
        !current ||
        (execution && activeRuns.get(claims.session_id) !== execution.run_id) ||
        (fence.kind === 'claim'
          ? fence.run_id !== activeRuns.get(claims.session_id) ||
            fence.lease_owner !== current.lease_owner ||
            fence.lease_token !== current.lease_token
          : fence.goal_revision !== current.goal_revision)
      )
        return new Response(null, { status: 409 });
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(JSON.stringify(fence)),
          ),
        ),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      return Response.json({
        authorized: true,
        session_id: claims.session_id,
        runtime_id: claims.runtime_id,
        object_id: path.split('/objects/')[1].split('/')[0],
        fence_digest: hash,
        mode: current.mode,
      });
    }
    if (path.endsWith('/policy')) {
      policies++;
      const body = await request.json();
      if (body.purpose !== 'read' && !executionAllowed)
        return new Response(null, { status: 409 });
      if (!/^[a-f0-9]{64}$/.test(body.binding_digest))
        return new Response(null, { status: 409 });
      if (
        body.purpose !== 'read' &&
        body.execution &&
        activeRuns.get(claims.session_id) !== body.execution.run_id
      )
        return new Response(null, { status: 409 });
      let resumeProof;
      if (body.handoff_resume) {
        const fence = body.handoff_resume,
          current = handoffStopFences.get(claims.session_id);
        if (
          body.purpose === 'read' ||
          body.execution ||
          !current ||
          current.mode !== 'resume' ||
          fence.handoff_id !== current.handoff_id ||
          fence.handoff_revision !== current.handoff_revision
        )
          return new Response(null, { status: 409 });
        resumeProof = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(JSON.stringify(fence)),
            ),
          ),
          (n) => n.toString(16).padStart(2, '0'),
        ).join('');
      }
      if (holdNativePolicy && body.purpose !== 'read') {
        holdNativePolicy = false;
        heldPolicies++;
        let ended = false;
        let timer;
        return new Response(
          new ReadableStream({
            start(controller) {
              // Keep real pending I/O alive. Otherwise workerd detects this
              // fixture as a hung request and cancels it before the stop.
              timer = setTimeout(() => {
                if (!ended) {
                  ended = true;
                  heldPolicies--;
                  controller.error(new Error('Fixture policy timeout'));
                }
              }, 30000);
              controller.enqueue(new TextEncoder().encode('{"authorized":'));
              request.signal.addEventListener(
                'abort',
                () => {
                  if (!ended) {
                    ended = true;
                    heldPolicies--;
                    clearTimeout(timer);
                    controller.error(new Error('Fixture policy cancelled'));
                  }
                },
                { once: true },
              );
            },
            cancel() {
              if (!ended) {
                ended = true;
                heldPolicies--;
                clearTimeout(timer);
              }
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return Response.json({
        authorized: true,
        object_id: path.split('/objects/')[1].split('/')[0],
        session_id: claims.session_id,
        runtime_id: claims.runtime_id,
        ...(resumeProof
          ? { runtime: 'cloudflare-durable', fence_digest: resumeProof }
          : {}),
      });
    }
    if (path.endsWith('/inputs')) {
      const { input, purpose } = await request.json();
      if (
        purpose !== 'read' &&
        input.execution &&
        activeRuns.get(claims.session_id) !== input.execution.run_id
      )
        return new Response(null, { status: 409 });
      return Response.json({
        authorized: true,
        request_id: input.request_id,
        product_receipt_digest: input.product_receipt_digest,
      });
    }
    if (path.endsWith('/progress')) {
      const value = await request.json();
      progressAttempts++;
      if (denyProgress) return new Response(null, { status: 503 });
      const key = `${claims.session_id}:${value.progress.revision}`;
      const prior = handoffProgress.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(value))
        return new Response(null, { status: 409 });
      handoffProgress.set(key, value);
      if (
        loseProgressAck &&
        (!loseProgressAck.session_id ||
          loseProgressAck.session_id === claims.session_id) &&
        (loseProgressAck.control_revision === undefined ||
          loseProgressAck.control_revision === value.progress.control_revision)
      ) {
        loseProgressAck = false;
        return new Response(null, { status: 503 });
      }
      const payload_digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(JSON.stringify(value)),
          ),
        ),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      return Response.json({
        accepted: true,
        handoff_id: value.progress.handoff.handoff_id,
        revision: value.progress.revision,
        payload_digest,
        last_revision: value.progress.revision,
      });
    }
    if (path.endsWith('/results')) {
      const { input } = await request.json();
      resultAttempts++;
      resultAttemptsBySession.set(
        claims.session_id,
        (resultAttemptsBySession.get(claims.session_id) ?? 0) + 1,
      );
      delivered.set(
        `${claims.session_id}:${input.request_id}`,
        claims.session_id,
      );
      if (loseResultAck) {
        loseResultAck = false;
        return new Response(null, { status: 503 });
      }
      return Response.json({ delivered: true, request_id: input.request_id });
    }
    if (path.endsWith('/controls')) {
      const input = await request.json();
      return Response.json({
        authorized: true,
        id: input.id,
        digest: input.digest,
      });
    }
    if (path.endsWith('/tools')) {
      const input = await request.json();
      if (input.name === 'create_approved_artifact') {
        artifactRequests.push(input);
        const key = `${claims.session_id}:${input.task_id}`;
        let row = artifacts.get(key);
        if (!row && input.phase === 'propose') {
          row = {
            approval_id: crypto.randomUUID(),
            parameters_digest: 'b'.repeat(64),
            content_digest: 'c'.repeat(64),
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            state: 'pending',
          };
          artifacts.set(key, row);
        }
        if (!row && input.phase !== 'probe')
          return new Response(null, { status: 409 });
        if (
          row &&
          input.phase === 'execute' &&
          ['approved', 'completed'].includes(row.state)
        ) {
          artifactEffects.add(row.approval_id);
          row.state = 'completed';
        }
        const reply = JSON.stringify({
          id: input.id,
          task_id: input.task_id,
          call_id: input.call_id,
          parameters_digest: input.parameters_digest,
          output: row ?? { state: 'missing' },
        });
        if (
          loseArtifactAck &&
          input.phase === 'execute' &&
          row?.state === 'completed'
        ) {
          loseArtifactAck = false;
          let timer;
          return new Response(
            new ReadableStream({
              start(controller) {
                timer = setTimeout(() => {
                  controller.enqueue(new TextEncoder().encode(reply));
                  controller.close();
                }, 20000);
              },
              cancel() {
                clearTimeout(timer);
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(reply, {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      memoryReads.push(input);
      const reply = JSON.stringify({
        id: input.id,
        task_id: input.task_id,
        call_id: input.call_id,
        parameters_digest: input.parameters_digest,
        output: {
          scope: 'personal',
          status: 'ok',
          entries: memoryAllowed
            ? [{ content: 'EXPLICIT_MEMORY_FIXTURE' }]
            : [],
        },
      });
      if (holdMemory && memoryReads.length === 1) {
        let timer;
        return new Response(
          new ReadableStream({
            start(controller) {
              timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(reply));
                controller.close();
              }, 20000);
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(reply, {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.includes('/model/')) {
      if (!executionAllowed) return new Response(null, { status: 409 });
      models++;
      const envelope = await request.json();
      if (
        envelope.execution &&
        activeRuns.get(claims.session_id) !== envelope.execution.run_id
      )
        return new Response(null, { status: 409 });
      const body = envelope.execution ? envelope.request : envelope;
      if (JSON.stringify(body.messages).includes('HOLD_AUTH_POLICY_FIXTURE'))
        holdNativePolicy = true;
      if (envelope.execution)
        modelExecutions.push({
          session_id: claims.session_id,
          ...envelope.execution,
        });
      if (body.model !== 'product-configured-model')
        return new Response(null, { status: 409 });
      return env.MODEL.fetch('https://provider.fixture/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer fixture-model-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    }
    return new Response(null, { status: 404 });
  },
};
