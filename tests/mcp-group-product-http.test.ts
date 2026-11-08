import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  grantMemberTools,
} from './helpers/member-inbox-http-fixture.js';

test('actual Group member needs explicit lease-bound MCP consent; a later lease has no inherited tools and can receive a fresh exact grant', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_PI_MCP: 'true',
    MINICLAW_GROUP_MEMBER_INBOX: 'true',
  });
  const ledger = path.join(f.root, 'group-mcp-effects.jsonl');
  const calls = () =>
    fs.existsSync(ledger)
      ? fs
          .readFileSync(ledger, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line: string) => JSON.parse(line))
          .filter((r) => r.event === 'call')
      : [];
  try {
    await f.json(
      await f.call('/api/mcp-servers', 'POST', {
        id: 'group_fixture',
        command: process.execPath,
        args: [path.resolve('tests/fixtures/mcp-managed-server.mjs')],
        env: { MCP_TEST_LEDGER: ledger },
        pi: {
          version: 1,
          enabled: true,
          location: { kind: 'host' },
          tools: ['echo'],
        },
      }),
    );
    const { groupId, people } = await freshMemberGroup(f);
    await grantMemberTools(f, groupId, people[0].id, [
      'create_approved_artifact',
    ]);
    let previous: any, sessionId: string | undefined;
    const execute = async (index: number) => {
      const token = `GROUP_${index}_${randomUUID()}`;
      let toolName = 'mcp__group_fixture__echo',
        modelFailure: unknown;
      f.setModel((body) => {
        try {
          const lastUser =
            body.messages
              .map((m, index) => (m.role === 'user' ? index : -1))
              .filter((index) => index >= 0)
              .at(-1) ?? -1;
          const toolText = body.messages
            .slice(lastUser + 1)
            .filter((m) => m.role === 'tool')
            .map((m) => String(m.content))
            .join('\n');
          if (toolText.includes(token))
            return { text: 'GROUP_MCP_FINAL_' + token };
          if (!toolText.includes('artifactId')) {
            expect(body.tools?.map((t) => t.function.name)).not.toContain(
              toolName,
            );
            return {
              tool: {
                name: 'create_approved_artifact',
                arguments: { content: 'PUBLIC_ARTIFACT_' + index },
              },
            };
          }
          expect(body.tools?.map((t) => t.function.name)).toContain(toolName);
          return { tool: { name: toolName, arguments: { text: token } } };
        } catch (error) {
          modelFailure = error;
          return { text: 'SYNTHETIC_ASSERTION_FAILED' };
        }
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content:
            'Propose the public artifact, then call the explicitly authorized fixture tool.',
          mentions: [people[0].id],
          dispatch: true,
        }),
      );
      let state: any, task: any;
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        state = await f.snapshot(groupId);
        task = state.discussion?.awaiting?.find(
          (a: any) => a.profile_id === people[0].id,
        )?.task;
        return !!task?.approvals?.some((a: any) => a.state === 'pending');
      });
      const artifact = task.approvals.find((a: any) => a.state === 'pending');
      expect(
        state.discussion?.mcp_sessions?.find(
          (session: any) => session.session_id === task.session_id,
        ),
      ).toMatchObject({
        profile_id: people[0].id,
        workspace_jid: task.workspace_jid,
        can_consent: true,
      });
      const base = `/api/groups/${encodeURIComponent(task.workspace_jid)}/sessions/${task.session_id}`;
      if (sessionId) expect(task.session_id).toBe(sessionId);
      sessionId = task.session_id;
      expect(calls()).toHaveLength(index - 1);
      const options = await f.json<any>(await f.call(base + '/mcp'));
      const server = options.servers.find(
        (s: any) => s.server_id === 'group_fixture',
      );
      const consent = (
        await f.json<any>(
          await f.call(base + '/mcp/consents', 'POST', {
            request_id: randomUUID(),
            server_id: server.server_id,
            configuration_digest: server.configuration_digest,
            tools: ['echo'],
            ttl_seconds: 600,
            confirmed_startup_and_restart: true,
          }),
        )
      ).consent;
      expect(consent.state, f.diagnostics()).toBe('active');
      toolName = JSON.parse(consent.catalog_json)[0].identity.registered_name;
      const binding = JSON.parse(consent.binding_json);
      expect(binding.member.lease_id).toBeTruthy();
      expect(binding.member.run_id).toBe(state.discussion.run.id);
      if (previous)
        expect(binding.member.lease_id).not.toBe(previous.member.lease_id);
      previous = binding;
      await f.json(
        await f.call(`${base}/approvals/${artifact.id}`, 'POST', {
          requestId: randomUUID(),
          parametersDigest: artifact.parameters_digest,
          decision: 'approve',
        }),
      );
      let pending: any;
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        const snap = await f.json<any>(await f.call(base + '/runtime'));
        pending = snap.mcp_approvals?.find((a: any) => a.state === 'pending');
        return !!pending;
      });
      expect(pending.intent.source.member).toEqual(binding.member);
      expect(pending.intent.grant_id).toBe(consent.id);
      const ownerView = await f.snapshot(groupId);
      const actionable = ownerView.discussion?.mcp_sessions
        ?.find((session) => session.session_id === task.session_id)
        ?.mcp_approvals.find((approval) => approval.id === pending.id);
      expect(actionable).toMatchObject({
        id: pending.id,
        parameters_digest: pending.parameters_digest,
        state: 'pending',
        intent: {
          server_id: 'group_fixture',
          original_name: 'echo',
          arguments_digest: pending.intent.arguments_digest,
        },
      });
      expect(JSON.stringify(actionable)).not.toContain(token);
      expect(calls()).toHaveLength(index - 1);
      await f.json(
        await f.call(`${base}/mcp/approvals/${pending.id}`, 'POST', {
          requestId: randomUUID(),
          parametersDigest: pending.parameters_digest,
          decision: 'approve',
        }),
      );
      await waitFor(async () => {
        if (modelFailure) throw modelFailure;
        const s = await f.snapshot(groupId);
        return (
          s.discussion?.run?.status === 'completed' &&
          s.messages.some((m) => m.content === 'GROUP_MCP_FINAL_' + token)
        );
      }).catch(async (error) => {
        const final = await f.snapshot(groupId);
        throw new Error(
          JSON.stringify({
            cause: String(error),
            calls: calls(),
            discussion: final.discussion,
            messages: final.messages.map((m) => ({ content: m.content })),
            models: f.requests.map((b) => ({
              tools: b.tools?.map((t) => t.function.name),
              messages: b.messages.map((m) => ({
                role: m.role,
                content: String(m.content).slice(-150),
              })),
            })),
          }),
        );
      });
      expect(calls()).toHaveLength(index);
      const idleSession = (
        await f.snapshot(groupId)
      ).discussion?.mcp_sessions?.find(
        (session) => session.session_id === task.session_id,
      );
      expect(idleSession?.can_consent).toBe(false);
    };
    await execute(1);
    let deniedFailure: unknown;
    f.setModel((body) => {
      try {
        expect(body.tools?.map((t) => t.function.name)).not.toContain(
          'mcp__group_fixture__echo',
        );
      } catch (error) {
        deniedFailure = error;
      }
      return { text: 'NEW_LEASE_WITHOUT_MCP' };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Only answer this public message.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(async () => {
      if (deniedFailure) throw deniedFailure;
      const s = await f.snapshot(groupId);
      return (
        s.discussion?.run?.status === 'completed' &&
        s.messages.some((m) => m.content === 'NEW_LEASE_WITHOUT_MCP')
      );
    });
    expect(calls()).toHaveLength(1);
    await execute(2);
  } finally {
    await f.dispose();
  }
}, 180000);
