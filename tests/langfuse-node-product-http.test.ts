// Actual authenticated Node Durable product, synthetic model and isolated
// HTTPS OTLP collector. No real Langfuse project or user content is contacted.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('two concurrent Node Durable Sessions export isolated metadata after real provider HTTP starts', async () => {
  const runtimeEnv: Record<string, string> = {};
  const f = await botHandoffHttpFixture(undefined, runtimeEnv);
  const collected: unknown[] = [];
  let collector: ReturnType<typeof createServer> | undefined;
  try {
    const certificate = path.join(f.root, 'collector.crt');
    const privateKey = path.join(f.root, 'collector.key');
    const opensslConfig = path.join(f.root, 'collector.cnf');
    fs.writeFileSync(
      opensslConfig,
      [
        '[req]',
        'prompt=no',
        'distinguished_name=dn',
        'x509_extensions=extensions',
        '[dn]',
        'CN=127.0.0.1',
        '[extensions]',
        'subjectAltName=IP:127.0.0.1',
        'basicConstraints=CA:TRUE',
        'keyUsage=keyCertSign,digitalSignature',
        '',
      ].join('\n'),
    );
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '1',
        '-keyout',
        privateKey,
        '-out',
        certificate,
        '-config',
        opensslConfig,
      ],
      { stdio: 'ignore' },
    );
    collector = createServer(
      { key: fs.readFileSync(privateKey), cert: fs.readFileSync(certificate) },
      async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const plain =
          request.headers['content-encoding'] === 'gzip'
            ? gunzipSync(body)
            : body;
        if (request.url === '/api/public/otel/v1/traces')
          collected.push(JSON.parse(plain.toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      },
    );
    collector.listen(0, '127.0.0.1');
    await once(collector, 'listening');
    const port = (collector.address() as { port: number }).port;
    const input = {
      enabled: true,
      origin: `https://127.0.0.1:${port}/`,
      sampleRate: 1,
      publicKey: 'pk-fixture',
      secretKey: 'COLLECTOR_SECRET_NOT_FOR_EXPORT',
    };
    execFileSync(
      process.execPath,
      [path.resolve('scripts/configure-langfuse.mjs')],
      {
        cwd: f.root,
        input: JSON.stringify(input),
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    runtimeEnv.NODE_EXTRA_CA_CERTS = certificate;
    await f.stop();
    await f.start();
    const options = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    const jid = options.workspaces[0].jid;
    const makeSession = async (name: string) =>
      (
        await f.json<{ session: { id: string } }>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/sessions`,
            'POST',
            {
              name,
              runtime: 'node-durable',
            },
          ),
        )
      ).session.id;
    const ids = await Promise.all([
      makeSession('Private trace fixture A'),
      makeSession('Private trace fixture B'),
    ]);
    const prompt = 'PRIVATE_PROMPT_DO_NOT_EXPORT';
    const requestIds = ids.map(() => randomUUID());
    await Promise.all(
      ids.map(async (id, index) =>
        f.json(
          await f.call('/api/messages', 'POST', {
            chatJid: jid,
            agentId: id,
            requestId: requestIds[index],
            content: `${prompt}_${index}`,
          }),
        ),
      ),
    );
    await waitFor(async () => {
      const snapshots = await Promise.all(
        ids.map(async (id) =>
          f.json<{ inputs: { state: string }[] }>(
            await f.call(
              `/api/groups/${encodeURIComponent(jid)}/sessions/${id}/runtime`,
            ),
          ),
        ),
      );
      return snapshots.every(
        (snapshot) =>
          snapshot.inputs.length === 1 &&
          snapshot.inputs[0].state === 'completed',
      );
    }, 60_000);
    const spans = () =>
      collected.flatMap(
        (body) =>
          (
            body as {
              resourceSpans?: {
                scopeSpans?: { spans?: { name: string; traceId: string }[] }[];
              }[];
            }
          ).resourceSpans?.flatMap(
            (resource) =>
              resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? [],
          ) ?? [],
      );
    await waitFor(() => {
      const rows = spans();
      return (
        rows.filter((row) => row.name === 'dot.model.admission_wait').length ===
          2 &&
        rows.filter((row) => row.name === 'dot.model.generation').length === 2
      );
    }, 15_000);
    expect(f.requests).toHaveLength(2);
    expect(
      new Set(
        spans()
          .filter((row) => row.name === 'dot.model.generation')
          .map((row) => row.traceId),
      ).size,
    ).toBe(2);
    const bytes = JSON.stringify(collected);
    expect(bytes).toContain('dot.model.admission_wait');
    expect(bytes).toContain('dot.model.generation');
    for (const id of ids) expect(bytes).toContain(id);
    expect(bytes).not.toContain(prompt);
    for (const requestId of requestIds) expect(bytes).not.toContain(requestId);
    expect(bytes).not.toContain('COLLECTOR_SECRET_NOT_FOR_EXPORT');
    expect(bytes).not.toContain('BOT_FAULT_FIXTURE_DONE');
  } finally {
    await f.dispose();
    if (collector)
      await new Promise<void>((resolve) => collector!.close(() => resolve()));
  }
}, 120_000);
