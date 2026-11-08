// Actual local node and KimiCU startup with an isolated host and synthetic model.
// With the explicit synthetic-window fixture, it also exercises an approved click.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import { enableLocalComputer } from './helpers/live-device-node.js';

test.skipIf(
  process.platform !== 'darwin' ||
    !fs.existsSync('/Applications/KimiCU.app/Contents/MacOS/kimi-cu'),
)(
  'enabling computer setup makes its tools available to a new private session',
  async () => {
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_PI_MCP: 'true',
      MINICLAW_DEVICE_NODES: 'true',
    });
    const serverId = `opendot_computer_${randomUUID().replaceAll('-', '')}`;
    fs.symlinkSync(path.resolve('dist'), path.join(f.root, 'dist'));
    fs.symlinkSync(path.resolve('scripts'), path.join(f.root, 'scripts'));
    try {
      const group = await f.createGroup();
      const jid = group.workspaceJid;
      const device = await enableLocalComputer(f, {
        serverId,
        ticketName: 'Synthetic computer',
      });
      const session = (
        await f.json<any>(
          await f.call(
            `/api/groups/${encodeURIComponent(jid)}/sessions`,
            'POST',
            { name: 'Automatic computer fixture', runtime: 'node-durable' },
          ),
        )
      ).session.id;
      f.setModel(() => ({ text: 'SYNTHETIC_DONE' }));
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: session,
          requestId: randomUUID(),
          content: 'Synthetic availability check',
          followUpBehavior: 'queue',
        }),
      );
      await waitFor(() => f.requests.length > 0, 60000);
      const settings = await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions/${session}/mcp`,
        ),
      );
      expect(
        settings.consents.some(
          (entry: any) =>
            entry.state === 'active' &&
            JSON.parse(entry.binding_json).server_id === serverId,
        ),
      ).toBe(true);
      const consent = settings.consents.find(
        (entry: any) =>
          entry.state === 'active' &&
          JSON.parse(entry.binding_json).server_id === serverId,
      );
      const registered = JSON.parse(consent.catalog_json).find(
        (entry: any) => entry.identity.original_name === 'list_windows',
      ).identity.registered_name;
      expect(
        f.requests.some((request) =>
          (request.tools ?? []).some(
            (tool) => tool.function.name === registered,
          ),
        ),
      ).toBe(true);
      if (process.env.OPENDOT_TEST_KIMICU_PID) {
        const names = Object.fromEntries(
          JSON.parse(consent.catalog_json).map((entry: any) => [
            entry.identity.original_name,
            entry.identity.registered_name,
          ]),
        ) as Record<string, string>;
        let actionResult = '';
        f.setModel((body) => {
          const lastUser =
            body.messages
              .map((message, i) => (message.role === 'user' ? i : -1))
              .filter((i) => i >= 0)
              .at(-1) ?? -1;
          const results = body.messages
            .slice(lastUser + 1)
            .filter((message) => message.role === 'tool');
          if (!results.length)
            return {
              tool: {
                name: names.list_windows,
                arguments: {
                  application: 'net.opendot.kimi-screenshot-fixture',
                },
              },
            };
          if (results.length === 1) {
            const text = String(results[0].content);
            const beforeTitle = text.split('OpenDot Green Fixture')[0];
            const handle = beforeTitle
              .match(
                /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
              )
              ?.at(-1);
            return handle
              ? {
                  tool: {
                    name: names.observe_window,
                    arguments: {
                      window: handle,
                      label: 'Fixture — OpenDot Green Fixture',
                    },
                  },
                }
              : { text: 'WINDOW_PARSE_FAILED' };
          }
          if (results.length === 2) {
            const text = String(results[1].content);
            const token = text.match(
              /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,
            )?.[0];
            const index = /\[(\d+)\] AXButton [^\n]*Run synthetic action/.exec(
              text,
            )?.[1];
            const element = text
              .replaceAll('\\n', '\n')
              .split('\n')
              .find((line) =>
                /\[\d+\] AXButton .*Run synthetic action/.test(line),
              )
              ?.trim();
            return token && index && element
              ? {
                  tool: {
                    name: names.act_on_window,
                    arguments: {
                      token,
                      action: 'click',
                      index: Number(index),
                      label: 'Fixture — OpenDot Green Fixture',
                      element,
                    },
                  },
                }
              : { text: 'OBSERVATION_PARSE_FAILED' };
          }
          actionResult = String(results[2].content);
          return { text: 'SYNTHETIC_ACTION_DONE' };
        });
        const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${session}`;
        await waitFor(async () =>
          (await f.json<any>(await f.call(`${base}/runtime`))).inputs.some(
            (input: any) => input.state === 'completed',
          ),
        );
        await f.json(
          await f.call('/api/messages', 'POST', {
            chatJid: jid,
            agentId: session,
            requestId: randomUUID(),
            content: 'Operate only the synthetic fixture window.',
            followUpBehavior: 'queue',
          }),
        );
        const seen = new Set<string>();
        for (let i = 0; i < 3; i++) {
          let approval: any;
          await waitFor(async () => {
            approval = (
              await f.json<any>(await f.call(`${base}/runtime`))
            ).mcp_approvals?.find(
              (entry: any) => entry.state === 'pending' && !seen.has(entry.id),
            );
            return !!approval;
          }, 60000);
          seen.add(approval.id);
          await f.json(
            await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', {
              parametersDigest: approval.parameters_digest,
              decision: 'approve',
              requestId: randomUUID(),
            }),
          );
        }
        await waitFor(() => !!actionResult, 60000);
        expect(actionResult).toContain('native_verified');
      }
      // A user revocation must not be silently replaced by automatic setup.
      const grantId = JSON.parse(consent.binding_json).device_grant_id;
      await f.json(
        await f.call(`/api/device-nodes/mcp-grants/${grantId}/revoke`, 'POST', {
          confirmed: true,
        }),
      );
      f.setModel(() => ({ text: 'AFTER_REVOCATION' }));
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          agentId: session,
          requestId: randomUUID(),
          content: 'Synthetic follow-up after revocation',
          followUpBehavior: 'queue',
        }),
      );
      const afterRevoke = await f.json<any>(
        await f.call(
          `/api/groups/${encodeURIComponent(jid)}/sessions/${session}/mcp`,
        ),
      );
      expect(
        afterRevoke.consents.filter(
          (entry: any) => JSON.parse(entry.binding_json).server_id === serverId,
        ),
      ).toHaveLength(1);
      await f.json(await f.call('/api/local-device-setup/computer', 'DELETE'));
      expect(
        (await f.json<any>(await f.call('/api/device-nodes'))).devices.find(
          (d: any) => d.id === device.id,
        ).state,
      ).toBe('revoked');
    } finally {
      await f
        .call(`/api/local-device-setup/stop/${serverId}`, 'POST', {})
        .catch(() => null);
      await f.dispose();
    }
  },
  180000,
);
