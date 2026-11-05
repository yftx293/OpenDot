// Test-only HTTP provider in a second real workerd Worker. No vendor inference.
let requests = 0;
let declaredTools = [];
let interruptArtifactAnswer = false;
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/reset') {
      requests = 0;
      declaredTools = [];
      interruptArtifactAnswer = false;
      return Response.json({ requests });
    }
    if (path === '/interrupt-artifact-answer') {
      interruptArtifactAnswer = true;
      return Response.json({ ok: true });
    }
    if (path === '/requests') return Response.json({ requests });
    if (path === '/request-tools')
      return Response.json({ requests, declaredTools });
    if (
      path !== '/v1/chat/completions' ||
      request.headers.get('Authorization') !== 'Bearer fixture-model-key'
    )
      return new Response('Denied', { status: 403 });
    requests++;
    const body = await request.json();
    declaredTools.push((body.tools ?? []).map((tool) => tool.function.name));
    const last = body.messages.at(-1);
    if (String(last.content).includes('TIMEOUT_FIXTURE'))
      return Response.json(
        { error: { message: 'Fixture timeout' } },
        { status: 504 },
      );
    if (
      String(last.content).includes('HOLD_REQUEST_FIXTURE') ||
      (String(last.content).includes('INTERRUPT_ONCE') && requests === 1) ||
      (interruptArtifactAnswer && last.role === 'tool' && requests === 2)
    ) {
      const encoder = new TextEncoder();
      let timer;
      return new Response(
        new ReadableStream({
          start(controller) {
            timer = setTimeout(() => controller.close(), 10000);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: 'interrupted', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'PARTIAL_BEFORE_RESET' }, finish_reason: null }] })}\n\n`,
              ),
            );
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }

    const artifact =
      last.role === 'user' && String(last.content).includes('ARTIFACT_FIXTURE');
    const memory =
      last.role === 'user' && String(last.content).includes('MEMORY_FIXTURE');
    const useTool =
      artifact ||
      memory ||
      (last.role === 'user' && String(last.content).includes('inspect'));
    const delta = useTool
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'inspect1',
              type: 'function',
              function: {
                name: artifact
                  ? 'create_approved_artifact'
                  : memory
                    ? 'read_personal_memory'
                    : 'inspect_text',
                arguments: artifact
                  ? '{"content":"EXACT_ARTIFACT_FIXTURE"}'
                  : memory
                    ? '{"query":"preference"}'
                    : '{"text":"CLOUD_EVIDENCE"}',
              },
            },
          ],
        }
      : {
          role: 'assistant',
          content:
            last.role === 'tool'
              ? `verified: ${last.content}`
              : 'CLOUD_MODEL_RESULT',
        };
    const packet = (delta, finish_reason) =>
      `data: ${JSON.stringify({ id: 'cf-test', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (String(last.content).includes('EOF_WITH_FINISH_FIXTURE')) {
      const bytes = new TextEncoder().encode(
        (
          packet({ role: 'assistant', content: 'PROTOCOL 完成' }, null) +
          packet({}, 'stop')
        ).replaceAll('\n', '\r\n'),
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return new Response(
      packet(delta, null) +
        packet({}, useTool ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  },
};
