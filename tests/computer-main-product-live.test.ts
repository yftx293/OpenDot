// The existing main chat keeps its history and uses a hidden authorization
// identity. This isolated test never exposes real window titles to the model.
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
  'main chat uses an approved computer tool without creating a visible conversation',
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
      // Start the main runner before enabling the capability; it must discover
      // the new setting on a subsequent turn without changing conversation.
      f.setModel(() => ({ text: 'BEFORE_COMPUTER_ENABLED' }));
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          content: 'Synthetic initial main chat',
          followUpBehavior: 'queue',
        }),
      );
      await waitFor(
        async () =>
          (
            await f.json<any>(
              await f.call(`/api/groups/${encodeURIComponent(jid)}/messages`),
            )
          ).messages.some((message: any) =>
            message.content?.includes('BEFORE_COMPUTER_ENABLED'),
          ),
        90000,
      );
      expect(
        (
          await f.json<any>(
            await f.call(
              `/api/groups/${encodeURIComponent(jid)}/computer-main`,
            ),
          )
        ).sessionId,
      ).toBeNull();
      await enableLocalComputer(f, {
        serverId,
        ticketName: 'Synthetic main computer',
      });
      const filter = `NoSuchOpenDotApp${randomUUID().replaceAll('-', '')}`;
      let toolOffered = false;
      f.setModel((body) => {
        const lastUser =
          body.messages
            .map((message, i) => (message.role === 'user' ? i : -1))
            .filter((i) => i >= 0)
            .at(-1) ?? -1;
        if (
          body.messages
            .slice(lastUser + 1)
            .some((message) => message.role === 'tool')
        )
          return { text: 'MAIN_COMPUTER_FIXTURE_DONE' };
        const tool = (body.tools ?? []).find((entry: any) =>
          String(entry.function.description).includes(
            'List visible local application windows',
          ),
        );
        toolOffered = !!tool;
        return tool
          ? {
              tool: {
                name: tool.function.name,
                arguments: { application: filter },
              },
            }
          : { text: 'MAIN_COMPUTER_TOOL_MISSING' };
      });
      const previousRequests = f.requests.length;
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: jid,
          content: 'Use the synthetic computer tool to check the test app.',
          followUpBehavior: 'queue',
        }),
      );
      let sessionId: string | null = null;
      await waitFor(async () => {
        sessionId = (
          await f.json<any>(
            await f.call(
              `/api/groups/${encodeURIComponent(jid)}/computer-main`,
            ),
          )
        ).sessionId;
        return !!sessionId;
      }, 90000);
      await waitFor(() => f.requests.length > previousRequests, 90000);
      if (!toolOffered) {
        const toolNames = f.requests
          .flatMap((request) =>
            (request.tools ?? []).map((entry: any) => entry.function.name),
          )
          .filter((name: string) => name.includes('computer'));
        const diagnostics = f
          .diagnostics()
          .split('\n')
          .filter((line) =>
            /external mcp|computer capability|coding mcp/i.test(line),
          )
          .slice(-12);
        console.log(
          'Synthetic main tool diagnostics',
          JSON.stringify({ toolNames, diagnostics }),
        );
      }
      expect(
        f.requests.some((request) =>
          (request.tools ?? []).some((entry: any) =>
            String(entry.function.description).includes(
              'List visible local application windows',
            ),
          ),
        ),
      ).toBe(true);
      const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${sessionId}`;
      let approval: any;
      await waitFor(async () => {
        approval = (
          await f.json<any>(await f.call(`${base}/mcp`))
        ).approvals?.find((item: any) => item.state === 'pending');
        return !!approval;
      }, 90000);
      expect(toolOffered).toBe(true);
      expect(approval.intent.original_name).toBe('list_windows');
      expect(
        (
          await f.json<any>(
            await f.call(`${base}/mcp/approvals/${approval.id}/arguments`),
          )
        ).arguments,
      ).toEqual({ application: filter });
      await f.json(
        await f.call(`${base}/mcp/approvals/${approval.id}`, 'POST', {
          parametersDigest: approval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        }),
      );
      await waitFor(
        async () =>
          (await f.json<any>(await f.call(`${base}/mcp`))).approvals?.some(
            (item: any) =>
              item.id === approval.id && item.state === 'completed',
          ),
        90000,
      );
      await waitFor(
        async () =>
          (
            await f.json<any>(
              await f.call(`/api/groups/${encodeURIComponent(jid)}/messages`),
            )
          ).messages.some((message: any) =>
            message.content?.includes('MAIN_COMPUTER_FIXTURE_DONE'),
          ),
        60000,
      );
      const visible = await f.json<any>(
        await f.call(`/api/groups/${encodeURIComponent(jid)}/sessions`),
      );
      expect(JSON.stringify(visible)).not.toContain(sessionId);
      await f.json(await f.call('/api/local-device-setup/computer', 'DELETE'));
    } finally {
      await f
        .call(`/api/local-device-setup/stop/${serverId}`, 'POST', {})
        .catch(() => null);
      await f.dispose();
    }
  },
  240000,
);
