// Actual paired node, Host authority, MCP process and Durable runtime; model is synthetic.
import path from 'node:path';
import { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import { readKimiCuAppState } from './helpers/kimicu-mcp.js';
import {
  countDeviceCommands,
  pairApprovedDeviceServer,
} from './helpers/live-device-node.js';
import { installOptionalGroupModel } from './helpers/live-openai-model.js';

test.skipIf(
  process.platform !== 'darwin' ||
    !process.env.OPENDOT_TEST_KIMICU_PID ||
    !process.env.OPENDOT_TEST_KIMICU_WINDOW_ID,
)(
  'real KimiCU paired device requires exact approvals for observation and action',
  async () => {
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_PI_MCP: 'true',
      MINICLAW_DEVICE_NODES: 'true',
    });
    const realModelPath = await installOptionalGroupModel(
      f,
      'Isolated KimiCU real model',
    );
    let node: ChildProcess | undefined;
    let nodeLog = { text: '' };
    const env = {
      OPENDOT_KIMICU_APP_ID: 'net.opendot.kimi-fixture',
      OPENDOT_KIMICU_PID: process.env.OPENDOT_TEST_KIMICU_PID!,
      OPENDOT_KIMICU_WINDOW_ID: process.env.OPENDOT_TEST_KIMICU_WINDOW_ID!,
    };
    try {
      const group = await f.createGroup();
      const jid = group.workspaceJid;
      const placeholder = randomUUID();
      const policy = {
        version: 1,
        enabled: true,
        location: { kind: 'device', node_id: placeholder },
        tools: ['observe_window', 'act_on_window', 'capture_window'],
      };
      const paired = await pairApprovedDeviceServer(f, {
        id: 'device_fixture',
        command: process.execPath,
        args: [path.resolve('dist/personal-agent/kimi-cu-mcp.js')],
        env,
        policy,
      });
      node = paired.node;
      nodeLog = paired.nodeLog;
      const { device, ticket } = paired;
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
          server_id: 'device_fixture',
          declaration_digest: declaration,
          tools: ['observe_window', 'act_on_window', 'capture_window'],
          allow_images: true,
          ttl_seconds: 600,
        }),
      );
      const settings = await f.json<any>(await f.call(`${base}/mcp`));
      const selected = settings.servers.find(
        (entry: any) => entry.server_id === 'device_fixture',
      );
      expect(selected).toBeDefined();
      const consent = await f.json<any>(
        await f.call(`${base}/mcp/consents`, 'POST', {
          request_id: randomUUID(),
          server_id: selected.server_id,
          configuration_digest: selected.configuration_digest,
          tools: ['observe_window', 'act_on_window', 'capture_window'],
          ttl_seconds: 600,
          confirmed_startup_and_restart: true,
          device_grant_id: grant.grant.grant_id,
        }),
      );
      expect(consent.consent.state).toBe('active');
      const entries = JSON.parse(consent.consent.catalog_json);
      const toolName = (name: string) =>
        entries.find((entry: any) => entry.identity.original_name === name)
          .identity.registered_name;
      let observation = '';
      if (!realModelPath)
        f.setModel((body) => {
          const last =
            body.messages
              .map((m, i) => (m.role === 'user' ? i : -1))
              .filter((i) => i >= 0)
              .at(-1) ?? -1;
          const results = body.messages
            .slice(last + 1)
            .filter((m) => m.role === 'tool');
          if (!results.length)
            return {
              tool: { name: toolName('observe_window'), arguments: {} },
            };
          if (results.length === 1) {
            observation = String(results[0].content);
            const token =
              /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.exec(
                observation,
              )?.[0];
            const index = /\[(\d+)\] AXButton \(Run fixture action\)/.exec(
              observation,
            )?.[1];
            if (!token || !index) return { text: 'OBSERVATION_PARSE_FAILED' };
            return {
              tool: {
                name: toolName('act_on_window'),
                arguments: { token, action: 'click', index: Number(index) },
              },
            };
          }
          if (results.length === 2)
            return {
              tool: { name: toolName('capture_window'), arguments: {} },
            };
          return { text: 'KIMICU_DONE' };
        });
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: session,
          requestId: randomUUID(),
          content: `This is an isolated test application. First call ${toolName('observe_window')} with empty arguments. From its result, use the token and the index of the button named Run fixture action to call ${toolName('act_on_window')} with action click. Then call ${toolName('capture_window')} with empty arguments. Report completion only after all three tools.`,
          followUpBehavior: 'queue',
        }),
      );
      const seen = new Set<string>();
      let current: any;
      for (let i = 0; i < 3; i++) {
        let approval: any;
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          approval = current.mcp_approvals?.find(
            (a: any) => a.state === 'pending' && !seen.has(a.id),
          );
          return !!approval;
        });
        seen.add(approval.id);
        await f.json(
          await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', {
            parametersDigest: approval.parameters_digest,
            decision: 'approve',
            requestId: randomUUID(),
          }),
        );
      }
      await waitFor(async () => {
        current = await f.json<any>(await f.call(`${base}/runtime`));
        return current.inputs.some((input: any) => input.state === 'completed');
      });
      if (!realModelPath) expect(observation).toContain('Fixture ready');
      else expect(f.requests).toHaveLength(0);
      expect(
        await readKimiCuAppState({
          app: 'net.opendot.kimi-fixture',
          pid: Number(env.OPENDOT_KIMICU_PID),
          windowId: Number(env.OPENDOT_KIMICU_WINDOW_ID),
        }),
      ).toContain('Fixture action complete');
      expect(
        current.mcp_approvals.filter((a: any) => a.state === 'completed'),
      ).toHaveLength(3);
      const verify = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      try {
        const attachment = verify
          .prepare('SELECT mime, size FROM device_attachments')
          .get() as { mime: string; size: number };
        expect(attachment.mime).toBe('image/png');
        expect(attachment.size).toBeGreaterThan(0);
        expect(
          verify.prepare('SELECT count(*) AS n FROM device_attachments').get(),
        ).toEqual({ n: 1 });
      } finally {
        verify.close();
      }
      expect(JSON.stringify(f.requests)).not.toContain('/9j/');
      expect(JSON.stringify(f.requests)).not.toContain('iVBORw0KGgo');
      expect(nodeLog.text).not.toContain('/9j/');
      expect(nodeLog.text).not.toContain('iVBORw0KGgo');
      expect(nodeLog.text).not.toContain(ticket.pair_code);

      // Exercise the real paired device after the owner revokes its grant.
      // The synthetic model deliberately requests an observation; the device
      // command ledger must not grow even if the model tries to use the tool.
      if (!realModelPath) {
        const beforeRevocation = countDeviceCommands(f.root);
        let pendingAttempted = false;
        f.setModel(() => {
          if (pendingAttempted) return { text: 'LATE_APPROVAL_DONE' };
          pendingAttempted = true;
          return { tool: { name: toolName('observe_window'), arguments: {} } };
        });
        const beforePending = new Set(
          current.inputs.map((input: any) => input.id),
        );
        await f.json(
          await f.call('/api/messages', 'POST', {
            chatJid: jid,
            agentId: session,
            requestId: randomUUID(),
            content: 'Request one observation and wait for its approval.',
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
        await f.json(
          await f.call(
            `/api/device-nodes/mcp-grants/${grant.grant.grant_id}/revoke`,
            'POST',
            {
              confirmed: true,
            },
          ),
        );
        // A stale approval is submitted only after revocation. A decision may
        // be rejected immediately or recorded; neither may dispatch a device
        // operation once its grant has been revoked.
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
        let attempted = false;
        f.setModel(() => {
          if (attempted) return { text: 'REVOKED_DONE' };
          attempted = true;
          return { tool: { name: toolName('observe_window'), arguments: {} } };
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
              'Attempt one observation of the isolated fixture after revocation.',
            followUpBehavior: 'queue',
          }),
        );
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          return current.inputs.some(
            (input: any) =>
              ['completed', 'failed', 'blocked'].includes(input.state) &&
              !priorInputs.has(input.id),
          );
        });
        expect(attempted).toBe(true);
        expect(countDeviceCommands(f.root)).toBe(beforeRevocation);
      }
    } finally {
      if (node && node.exitCode === null && !node.signalCode) {
        node.kill('SIGINT');
        await once(node, 'exit').catch(() => {});
      }
      await f.dispose();
    }
  },
  300000,
);
