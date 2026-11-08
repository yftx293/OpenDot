// Actual paired node, Host authority, MCP process and Durable runtime; model is synthetic.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import { countDeviceCommands } from './helpers/live-device-node.js';
import { installOptionalGroupModel } from './helpers/live-openai-model.js';

test.skipIf(process.env.OPENDOT_TEST_WEBBRIDGE !== '1')(
  'real WebBridge read runs only after device approval and rejects an outside origin',
  async () => {
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_PI_MCP: 'true',
      MINICLAW_DEVICE_NODES: 'true',
    });
    const realModelPath = await installOptionalGroupModel(
      f,
      'Isolated WebBridge real model',
    );
    const site = http.createServer((_, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><title>OpenDot Fixture</title><body><script>window.__reads=0;Object.defineProperty(document.body,'innerText',{get(){window.__reads++;return 'OPENDOT_ALLOWED_FIXTURE'}})</script></body>`,
      );
    });
    const outside = http.createServer((_, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<title>Outside</title><body>OPENDOT_OUTSIDE_SECRET</body>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) =>
      outside.listen(0, '127.0.0.1', resolve),
    );
    const sitePort = (site.address() as any).port;
    const outsidePort = (outside.address() as any).port;
    let bridgeSession = '';
    const serverId = 'opendot_webbridge_' + randomUUID().replaceAll('-', '');
    fs.symlinkSync(path.resolve('dist'), path.join(f.root, 'dist'));
    const bridge = async (action: string, args: unknown) => {
      const response = await fetch('http://127.0.0.1:10086/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, args, session: bridgeSession }),
        signal: AbortSignal.timeout(15000),
      });
      const data: any = await response.json();
      if (!response.ok || !data.ok)
        throw new Error('Synthetic WebBridge fixture unavailable');
      return data.data;
    };
    let tabId = 0;
    try {
      const prepared = await f.json<any>(
        await f.call('/api/local-device-setup/webbridge-tab', 'POST', {
          url: `http://127.0.0.1:${sitePort}/`,
          port: 10086,
        }),
      );
      bridgeSession = prepared.session;
      tabId = prepared.tabId;
      expect(tabId).toBeGreaterThan(0);
      const paths = await f.json<any>(await f.call('/api/local-device-setup'));
      expect(paths.available).toBe(true);
      const env = {
        OPENDOT_WEBBRIDGE_SESSION: bridgeSession,
        OPENDOT_WEBBRIDGE_TAB_ID: String(tabId),
        OPENDOT_WEBBRIDGE_ORIGIN: `http://127.0.0.1:${sitePort}`,
        OPENDOT_WEBBRIDGE_PORT: '10086',
      };
      const group = await f.createGroup();
      const jid = group.workspaceJid;
      const placeholder = randomUUID();
      const policy = {
        version: 1,
        enabled: true,
        location: { kind: 'device', node_id: placeholder },
        tools: ['read_page'],
      };
      const created = await f.json<any>(
        await f.call('/api/mcp-servers', 'POST', {
          id: serverId,
          command: paths.command,
          args: [
            ...(paths.loader ? ['--import', paths.loader] : []),
            paths.browser,
          ],
          env,
          pi: policy,
        }),
      );
      expect(created.server).toBeDefined();
      const { ticket } = await f.json<any>(
        await f.call('/api/device-nodes/pair-tickets', 'POST', {
          name: 'Fixture node',
        }),
      );
      await f.json(
        await f.call('/api/local-device-setup/start', 'POST', {
          serverId,
          pairCode: ticket.pair_code,
        }),
      );
      // A lost HTTP reply may cause the client to repeat the same start. The
      // backend must return the original startup rather than spawn a new node.
      await f.json(
        await f.call('/api/local-device-setup/start', 'POST', {
          serverId,
          pairCode: ticket.pair_code,
        }),
      );
      expect(
        (
          await f.call('/api/local-device-setup/start', 'POST', {
            serverId,
            pairCode: 'different-fixture-code',
          })
        ).status,
      ).toBe(409);
      let device: any;
      await waitFor(async () => {
        device = (await f.json<any>(await f.call('/api/device-nodes')))
          .devices[0];
        return !!device;
      });
      expect(
        (await f.json<any>(await f.call('/api/device-nodes'))).devices,
      ).toHaveLength(1);
      device = (
        await f.json<any>(
          await f.call(`/api/device-nodes/${device.id}/approve`, 'POST', {
            confirmed: true,
            expected_revision: device.revision,
          }),
        )
      ).device;
      await f.json(
        await f.call(`/api/mcp-servers/${serverId}`, 'PATCH', {
          pi: { ...policy, location: { kind: 'device', node_id: device.id } },
        }),
      );
      const session = (
        await f.json<any>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/sessions`,
            'POST',
            { name: 'Device MCP fixture', runtime: 'node-durable' },
          ),
        )
      ).session.id;
      const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${session}`;
      const declaration = device.manifest.servers[0].configuration_digest;
      const grant = await f.json<any>(
        await f.call(`/api/device-nodes/${device.id}/mcp-grants`, 'POST', {
          confirmed: true,
          expected_revision: device.revision,
          workspace_jid: jid,
          session_id: session,
          dot_id: group.profileId,
          server_id: serverId,
          declaration_digest: declaration,
          tools: ['read_page'],
          ttl_seconds: 600,
        }),
      );
      const settings = await f.json<any>(await f.call(`${base}/mcp`));
      const selected = settings.servers.find(
        (entry: any) => entry.server_id === serverId,
      );
      expect(selected).toBeDefined();
      const consent = await f.json<any>(
        await f.call(`${base}/mcp/consents`, 'POST', {
          request_id: randomUUID(),
          server_id: selected.server_id,
          configuration_digest: selected.configuration_digest,
          tools: ['read_page'],
          ttl_seconds: 600,
          confirmed_startup_and_restart: true,
          device_grant_id: grant.grant.grant_id,
        }),
      );
      expect(consent.consent.state).toBe('active');
      const toolName = JSON.parse(consent.consent.catalog_json)[0].identity
        .registered_name;
      if (!realModelPath)
        f.setModel((body) => {
          const last =
            body.messages
              .map((m, i) => (m.role === 'user' ? i : -1))
              .filter((i) => i >= 0)
              .at(-1) ?? -1;
          const result = body.messages
            .slice(last + 1)
            .find((m) => m.role === 'tool');
          return result
            ? { text: 'READ_DONE' }
            : { tool: { name: toolName, arguments: {} } };
        });
      let current: any;
      const seen = new Set<string>();
      async function turn(
        expectedCompleted: number,
        checkBeforeApproval?: () => Promise<void>,
      ) {
        await f.json(
          await f.call('/api/messages', 'POST', {
            chatJid: jid,
            agentId: session,
            requestId: randomUUID(),
            content: `Use the available ${toolName} tool exactly once with empty arguments to read the isolated test page. Report the returned page text; if unavailable say so.`,
            followUpBehavior: 'queue',
          }),
        );
        let approval: any;
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          approval = current.mcp_approvals?.find(
            (a: any) => a.state === 'pending' && !seen.has(a.id),
          );
          return !!approval;
        });
        seen.add(approval.id);
        const approvedArguments = await f.json<any>(
          await f.call(`${base}/mcp/approvals/${approval.id}/arguments`),
        );
        expect(approvedArguments.arguments).toEqual({});
        if (checkBeforeApproval) await checkBeforeApproval();
        await f.json(
          await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          }),
        );
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          return (
            current.inputs.filter((input: any) => input.state === 'completed')
              .length >= expectedCompleted
          );
        });
      }
      await turn(1, async () => {
        const value = await bridge('evaluate', {
          tabId,
          code: 'window.__reads',
        });
        expect(value.value).toBe(0);
      });
      if (!realModelPath)
        expect(JSON.stringify(f.requests)).toContain('OPENDOT_ALLOWED_FIXTURE');
      else {
        const history = await f.json<any>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/messages?agentId=${encodeURIComponent(session)}`,
          ),
        );
        expect(JSON.stringify(history.messages)).toContain(
          'OPENDOT_ALLOWED_FIXTURE',
        );
        expect(f.requests).toHaveLength(0);
      }
      expect(
        (await bridge('evaluate', { tabId, code: 'window.__reads' })).value,
      ).toBe(1);
      await bridge('navigate', {
        tabId,
        url: `http://127.0.0.1:${outsidePort}/`,
      });
      await turn(2);
      expect(JSON.stringify(f.requests)).not.toContain(
        'OPENDOT_OUTSIDE_SECRET',
      );
      const finalHistory = await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/messages?agentId=${encodeURIComponent(session)}`,
        ),
      );
      expect(JSON.stringify(finalHistory.messages)).not.toContain(
        'OPENDOT_OUTSIDE_SECRET',
      );
      if (!realModelPath) {
        // Return to a freshly loaded in-scope page so its read counter proves
        // the revoked request did not reach the real WebBridge page adapter.
        await bridge('navigate', {
          tabId,
          url: `http://127.0.0.1:${sitePort}/`,
        });
        expect(
          (await bridge('evaluate', { tabId, code: 'window.__reads' })).value,
        ).toBe(0);
        const beforeRevocation = countDeviceCommands(f.root);
        let pendingAttempted = false;
        f.setModel(() => {
          if (pendingAttempted) return { text: 'LATE_APPROVAL_DONE' };
          pendingAttempted = true;
          return { tool: { name: toolName, arguments: {} } };
        });
        const beforePending = new Set(
          current.inputs.map((input: any) => input.id),
        );
        await f.json(
          await f.call('/api/messages', 'POST', {
            chatJid: jid,
            agentId: session,
            requestId: randomUUID(),
            content: 'Request an isolated page read and wait for approval.',
            followUpBehavior: 'queue',
          }),
        );
        let pending: any;
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          pending = current.mcp_approvals?.find(
            (a: any) => a.state === 'pending' && !seen.has(a.id),
          );
          return !!pending;
        });
        expect(pendingAttempted).toBe(true);
        expect(countDeviceCommands(f.root)).toBe(beforeRevocation);
        expect(
          (await bridge('evaluate', { tabId, code: 'window.__reads' })).value,
        ).toBe(0);
        await f.json(
          await f.call(
            `/api/device-nodes/mcp-grants/${grant.grant.grant_id}/revoke`,
            'POST',
            { confirmed: true },
          ),
        );
        const lateDecision = await f.call(
          `${base}/mcp/approvals/${pending.id}`,
          'POST',
          {
            parametersDigest: pending.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          },
        );
        expect([200, 409]).toContain(lateDecision.status);
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          return current.inputs.some(
            (input: any) =>
              !beforePending.has(input.id) &&
              ['completed', 'failed', 'blocked'].includes(input.state),
          );
        });
        expect(countDeviceCommands(f.root)).toBe(beforeRevocation);
        expect(
          (await bridge('evaluate', { tabId, code: 'window.__reads' })).value,
        ).toBe(0);
        let attempted = false;
        f.setModel(() => {
          if (attempted) return { text: 'REVOKED_DONE' };
          attempted = true;
          return { tool: { name: toolName, arguments: {} } };
        });
        const priorInputs = new Set(
          current.inputs.map((input: any) => input.id),
        );
        await f.json(
          await f.call('/api/messages', 'POST', {
            chatJid: jid,
            agentId: session,
            requestId: randomUUID(),
            content:
              'Attempt to read the isolated page after device grant revocation.',
            followUpBehavior: 'queue',
          }),
        );
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          return current.inputs.some(
            (input: any) =>
              !priorInputs.has(input.id) &&
              ['completed', 'failed', 'blocked'].includes(input.state),
          );
        });
        expect(attempted).toBe(true);
        expect(countDeviceCommands(f.root)).toBe(beforeRevocation);
        expect(
          (await bridge('evaluate', { tabId, code: 'window.__reads' })).value,
        ).toBe(0);
      }
    } finally {
      const stopped = await f
        .call(`/api/local-device-setup/stop/${serverId}`, 'POST', {})
        .catch(() => null);
      if (stopped?.ok)
        await waitFor(async () => {
          const status = await f.call(
            `/api/local-device-setup/status/${serverId}`,
          );
          return (
            status.ok &&
            ((await status.json()) as { state: string }).state === 'exited'
          );
        }, 5000);
      await bridge('close_session', {}).catch(() => {});
      await Promise.all([
        ...[site, outside].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              // Chrome may keep fixture connections alive after its test tab
              // closes; force only this isolated server's sockets to close.
              server.closeAllConnections();
            }),
        ),
      ]);
      await f.dispose();
    }
  },
  360000,
);
