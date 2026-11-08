// Real user-selected model, isolated host and synthetic app only. Before any
// device approval the test verifies the requested target and operation.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { McpClient, StdioTransport } from '@earendil-works/pi-mcp';
import { KimiCuBackend } from '../src/personal-agent/kimi-cu-backend.js';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import { enableLocalComputer } from './helpers/live-device-node.js';
import {
  installLiveOpenAIModel,
  readLiveOpenAIModel,
} from './helpers/live-openai-model.js';

test.skipIf(
  process.platform !== 'darwin' ||
    !process.env.OPENDOT_TEST_KIMICU_PID ||
    !process.env.MINICLAW_GROUP_MODEL_CONFIG,
)(
  'real model discovers and operates only the synthetic fixture after approvals',
  async () => {
    const model = readLiveOpenAIModel(process.env.MINICLAW_GROUP_MODEL_CONFIG!);
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_PI_MCP: 'true',
      MINICLAW_DEVICE_NODES: 'true',
    });
    const serverId = `opendot_computer_${randomUUID().replaceAll('-', '')}`;
    fs.symlinkSync(path.resolve('dist'), path.join(f.root, 'dist'));
    fs.symlinkSync(path.resolve('scripts'), path.join(f.root, 'scripts'));
    try {
      await installLiveOpenAIModel(f, model, { name: 'Isolated real model' });
      const group = await f.createGroup();
      const jid = group.workspaceJid;
      await enableLocalComputer(f, {
        serverId,
        ticketName: 'Synthetic computer',
      });
      const session = (
        await f.json<any>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/sessions`,
            'POST',
            { name: 'Isolated real computer model', runtime: 'node-durable' },
          ),
        )
      ).session.id;
      const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${session}`;
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: session,
          requestId: randomUUID(),
          content:
            'Only operate the synthetic test app. List windows with application filter net.opendot.kimi-screenshot-fixture and title filter OpenDot Green Fixture. Observe that window using its exact label and handle. Click its Run synthetic action button using its exact window label, element line and index from the observation. Do not open or inspect any other application. Report the result.',
          followUpBehavior: 'queue',
        }),
      );
      const seen = new Set<string>();
      const called = new Set<string>();
      let current: any;
      let clicks = 0;
      for (let i = 0; i < 8; i++) {
        let approval: any;
        await waitFor(async () => {
          current = await f.json<any>(await f.call(`${base}/runtime`));
          approval = current.mcp_approvals?.find(
            (entry: any) => entry.state === 'pending' && !seen.has(entry.id),
          );
          return (
            !!approval ||
            current.inputs.some((input: any) =>
              ['completed', 'failed', 'blocked'].includes(input.state),
            )
          );
        }, 90000);
        if (!approval) break;
        const args = (
          await f.json<any>(
            await f.call(`${base}/mcp/approvals/${approval.id}/arguments`),
          )
        ).arguments;
        const tool = approval.intent.original_name;
        expect(['list_windows', 'observe_window', 'act_on_window']).toContain(
          tool,
        );
        called.add(tool);
        if (tool === 'list_windows')
          expect(args).toEqual({
            application: 'net.opendot.kimi-screenshot-fixture',
            title: 'OpenDot Green Fixture',
          });
        if (tool === 'observe_window' || tool === 'act_on_window')
          expect(args.label).toBe('Fixture — OpenDot Green Fixture');
        if (tool === 'act_on_window') {
          expect(args.action).toBe('click');
          expect(++clicks).toBe(1);
        }
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
        return current.inputs.some((input: any) =>
          ['completed', 'failed', 'blocked'].includes(input.state),
        );
      }, 90000);
      expect(
        current.inputs.some((input: any) => input.state === 'completed'),
      ).toBe(true);
      expect([...called].sort()).toEqual([
        'act_on_window',
        'list_windows',
        'observe_window',
      ]);
      expect(clicks).toBe(1);
      expect(
        current.mcp_approvals.filter(
          (entry: any) => entry.state === 'completed',
        ).length,
      ).toBeGreaterThanOrEqual(3);
      expect(f.requests).toHaveLength(0);
      const client = new McpClient({
        name: 'synthetic-result-check',
        version: '1',
        capabilities: {},
        requestTimeoutMs: 10000,
      });
      client.onError(() => {});
      await client.connect(
        new StdioTransport({
          command: '/Applications/KimiCU.app/Contents/MacOS/kimi-cu',
          args: ['mcp'],
          cwd: '/',
          inheritEnv: false,
          env: {},
          stderr: 'pipe',
          maxMessageBytes: 6000000,
          maxStderrBytes: 4096,
          closeTimeoutMs: 1000,
        }),
      );
      try {
        const backend = new KimiCuBackend(client, {
          appId: 'net.opendot.kimi-screenshot-fixture',
          pid: Number(process.env.OPENDOT_TEST_KIMICU_PID),
          windowId: Number(process.env.OPENDOT_TEST_KIMICU_WINDOW_ID),
        });
        expect((await backend.observe()).text).toContain(
          'Synthetic action complete',
        );
      } finally {
        await client.close();
      }
    } finally {
      await f
        .call('/api/local-device-setup/computer', 'DELETE')
        .catch(() => null);
      await f.dispose();
    }
  },
  300000,
);
