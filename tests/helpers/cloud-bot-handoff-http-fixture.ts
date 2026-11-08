// Private production Node process + actual workerd. Only the model and HTTPS
// hostname-to-loopback routing are synthetic; no production transport is changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  authenticate,
  signedRequest,
  type CloudScope,
} from '../../src/personal-agent/cloud-wire.js';
import { botHandoffHttpFixture } from './bot-handoff-http-fixture.js';
interface WorkerRuntime {
  ready: Promise<URL>;
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}
export async function cloudBotHandoffHttpFixture(
  options: {
    goalTeams?: boolean;
    deviceNodes?: boolean;
    memberInbox?: boolean;
    authorityPreload?: string;
  } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-cloud-bot-bridge-'),
  );
  const requireCloud = createRequire(
    new URL('../../apps/cloud-agent/package.json', import.meta.url),
  );
  const { Miniflare, convertV4MiniflareOptions } = requireCloud(
    'miniflare',
  ) as {
    Miniflare: new (options: Record<string, unknown>) => WorkerRuntime;
    convertV4MiniflareOptions: (
      options: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
  const secret = randomBytes(32).toString('hex');
  let worker: WorkerRuntime | undefined,
    loseAck = false;
  const lostSubmissionAckPrefixes = new Set<string>();
  const submissionAckLosses: {
    path: string;
    request_id: string;
    native_status: number;
    receipt: { operationId: string; request_id: string; submission_id: number };
  }[] = [];
  let maskStopAck = false,
    stopAckLosses = 0;
  let loseDeviceConfirmation = false,
    deviceConfirmationLosses = 0;
  const submissions: { path: string; body: unknown }[] = [];
  const stops: { path: string; body: string; scope: CloudScope }[] = [];
  const stopFailures: { status: number; body: string }[] = [];
  const modelSources: unknown[] = [];
  const authorityTransportFailures: {
    path: string;
    observed_at: number;
    cause_code: string | null;
    node_signal: string | null;
    request_aborted: boolean;
  }[] = [];
  const memberModelRequests: {
    scope: CloudScope;
    path: string;
    body: string;
  }[] = [];
  const gateway = createServer(async (request, response) => {
    try {
      if (!worker || !request.url?.startsWith('/internal/cloud-sessions')) {
        response.writeHead(503);
        response.end();
        return;
      }
      let body = '';
      for await (const part of request) body += part;
      if (request.url.endsWith('/messages'))
        submissions.push({ path: request.url, body: JSON.parse(body) });
      if (request.url.endsWith('/suspend'))
        stops.push({
          path: request.url,
          body,
          scope: await authenticate(
            new Request('https://cloud.fixture' + request.url, {
              method: request.method,
              headers: request.headers as Record<string, string>,
            }),
            secret,
            body,
          ),
        });
      const result = await worker.dispatchFetch(
        'https://cloud.fixture' + request.url,
        {
          method: request.method,
          headers: request.headers as Record<string, string>,
          body: request.method === 'GET' ? undefined : body,
        },
      );
      if (request.url.endsWith('/suspend') && !result.ok)
        stopFailures.push({
          status: result.status,
          body: await result.clone().text(),
        });
      if (maskStopAck && request.url.endsWith('/suspend') && result.ok) {
        stopAckLosses++;
        await result.body?.cancel();
        response.writeHead(503);
        response.end();
        return;
      }
      if (request.url.endsWith('/messages') && result.ok) {
        const requestId = JSON.parse(body).request_id as string;
        const prefix = [...lostSubmissionAckPrefixes].find((p) =>
          requestId.startsWith(p),
        );
        if (loseAck || prefix) {
          loseAck = false;
          if (prefix) lostSubmissionAckPrefixes.delete(prefix);
          const native = (await result.clone().json()) as {
            receipt: {
              operationId: string;
              request_id: string;
              submission_id: number;
            };
          };
          submissionAckLosses.push({
            path: request.url,
            request_id: requestId,
            native_status: result.status,
            receipt: native.receipt,
          });
          await result.body?.cancel();
          response.writeHead(503);
          response.end();
          return;
        }
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(503);
      response.end();
    }
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayPort = (gateway.address() as { port: number }).port;
  const preload = path.join(directory, 'loopback-cloud-routing.mjs');
  fs.writeFileSync(
    preload,
    `
    ${options.authorityPreload ? `await import(${JSON.stringify(pathToFileURL(options.authorityPreload).href)});` : ''}
    const originalFetch=globalThis.fetch.bind(globalThis);
    globalThis.fetch=async(input,init)=>{
      const request=new Request(input,init),url=new URL(request.url);
      if(url.origin!=='https://cloud.fixture')return originalFetch(input,init);
      return originalFetch(new Request('http://127.0.0.1:${gatewayPort}'+url.pathname+url.search,{
        method:request.method,headers:request.headers,signal:request.signal,redirect:'error',
        body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),
      }));
    };
  `,
    { mode: 0o600 },
  );
  let product: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined;
  try {
    const cloudEnvironment = {
      ...(options.memberInbox
        ? {
            MINICLAW_GROUP_MEMBER_INBOX: 'true',
            MINICLAW_GROUP_MEMBER_CONCURRENCY: 'true',
            MINICLAW_GROUP_MEMBER_CLOUD: 'true',
          }
        : {}),
      ...(options.deviceNodes
        ? { MINICLAW_DEVICE_NODES: 'true', MINICLAW_CLOUD_DEVICES: 'true' }
        : {}),
      ...(options.goalTeams
        ? {
            MINICLAW_PERSONAL_GOALS: 'true',
            MINICLAW_GOAL_TEAMS: 'true',
            MINICLAW_CLOUD_GOALS: 'true',
          }
        : {}),
      MINICLAW_CLOUD_RUNTIME: 'true',
      MINICLAW_CLOUD_BOT_HANDOFFS: 'true',
      MINICLAW_CLOUD_APPROVALS: 'true',
      MINICLAW_CLOUD_SHARED_SECRET: secret,
      MINICLAW_CLOUD_ORIGIN: 'https://cloud.fixture',
    };
    product = await botHandoffHttpFixture(preload, cloudEnvironment);
    const bundle = fileURLToPath(
      new URL('../../apps/cloud-agent/dist/worker.js', import.meta.url),
    );
    if (!fs.existsSync(bundle))
      throw new Error('Build the Cloud dry-run bundle first');
    const start = (admission: boolean) =>
      new Miniflare(
        convertV4MiniflareOptions({
          name: 'miniclaw-cloud-bot-product',
          telemetry: { enabled: false },
          modules: true,
          scriptPath: bundle,
          modulesRoot: fileURLToPath(new URL('../../', import.meta.url)),
          compatibilityDate: '2026-10-13',
          compatibilityFlags: ['nodejs_compat'],
          durableObjects: {
            SESSIONS: { className: 'CloudSession', useSQLite: true },
          },
          resourcePersistencePath: path.join(directory, 'workerd'),
          bindings: {
            MINICLAW_CLOUD_ADMISSION: String(admission),
            MINICLAW_CLOUD_SHARED_SECRET: secret,
            MINICLAW_CLOUD_ORIGIN: 'https://cloud.fixture',
            MINICLAW_AUTHORITY_ORIGIN: 'https://authority.fixture',
          },
          serviceBindings: {
            MINICLAW_AUTHORITY_SERVICE: async (request: Request) => {
              const body = await request.text();
              if (request.url.includes('/model/') && JSON.parse(body).member) {
                modelSources.push(JSON.parse(body).member.source);
                memberModelRequests.push({
                  scope: await authenticate(request, secret, body),
                  path: new URL(request.url).pathname,
                  body,
                });
              }
              const result = await fetch(
                product!.origin + new URL(request.url).pathname,
                {
                  method: request.method,
                  headers: Object.fromEntries(request.headers),
                  body,
                  signal: request.signal,
                  redirect: 'error',
                },
              ).catch((error: unknown) => {
                const code = (error as { cause?: { code?: unknown } })?.cause
                  ?.code;
                authorityTransportFailures.push({
                  path: new URL(request.url).pathname,
                  observed_at: Date.now(),
                  cause_code: typeof code === 'string' ? code : null,
                  node_signal: product!.getChild()?.signalCode ?? null,
                  request_aborted: request.signal.aborted,
                });
                throw error;
              });
              if (
                loseDeviceConfirmation &&
                request.url.endsWith('/tools') &&
                result.ok &&
                JSON.parse(body).phase === 'confirm'
              ) {
                loseDeviceConfirmation = false;
                deviceConfirmationLosses++;
                await result.body?.cancel();
                return new Response('{}', { status: 503 });
              }
              return result;
            },
          },
        }),
      );
    worker = start(true);
    await worker.ready;
    return {
      ...product,
      submissions,
      modelSources,
      authorityTransportFailures: () => [...authorityTransportFailures],
      stopFailures,
      nativeStopCount: () => stops.length,
      maskStopAcknowledgements: (masked: boolean) => {
        maskStopAck = masked;
      },
      stopAcknowledgementLosses: () => stopAckLosses,
      replayStop: async (index: number) => {
        const original = stops[index];
        if (!original) throw new Error('Original native Stop request missing');
        const request = await signedRequest(
          secret,
          original.scope,
          'https://cloud.fixture' + original.path,
          'POST',
          original.body,
        );
        return worker!.dispatchFetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: original.body,
        });
      },
      // Re-sign a retained host request; never expose test secrets or headers.
      replayMemberModel: async (
        index: number,
        localBudgetExhausted = false,
      ) => {
        const original = memberModelRequests[index];
        if (!original) throw new Error('Original member model request missing');
        const decoded = JSON.parse(original.body);
        if (localBudgetExhausted) decoded.member.local_budget_exhausted = true;
        const body = localBudgetExhausted
          ? JSON.stringify(decoded)
          : original.body;
        const request = await signedRequest(
          secret,
          original.scope,
          product!.origin + original.path,
          'POST',
          body,
        );
        return fetch(request);
      },
      loseNextDeviceConfirmationAck: () => {
        loseDeviceConfirmation = true;
      },
      deviceConfirmationLosses: () => deviceConfirmationLosses,
      loseNextSubmissionAck: (requestPrefix?: string) => {
        if (requestPrefix) lostSubmissionAckPrefixes.add(requestPrefix);
        else loseAck = true;
      },
      submissionAcknowledgementLosses: () => [...submissionAckLosses],
      restartNode: async (admit = true, memberAdmission?: boolean) => {
        cloudEnvironment.MINICLAW_CLOUD_BOT_HANDOFFS = String(admit);
        if (memberAdmission !== undefined) {
          cloudEnvironment.MINICLAW_GROUP_MEMBER_INBOX =
            String(memberAdmission);
          cloudEnvironment.MINICLAW_GROUP_MEMBER_CONCURRENCY =
            String(memberAdmission);
          cloudEnvironment.MINICLAW_GROUP_MEMBER_CLOUD =
            String(memberAdmission);
        }
        await product!.stop('SIGKILL');
        await product!.start(preload);
      },
      restartWorker: async () => {
        await worker!.dispose();
        worker = start(false);
        await worker.ready;
      },
      dispose: async () => {
        await product!.stop();
        await worker?.dispose();
        await product!.dispose();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await product?.dispose();
    await worker?.dispose();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
