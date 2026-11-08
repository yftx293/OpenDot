// Actual private HTTP service/native Harness; deterministic provider only.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
// Multiple real process starts can each consume the fixture's 120-second
// readiness window. Business-state polling remains bounded to 30 seconds.
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('invited members and other administrators cannot spend Owner authority or read approval content; revoked Bot grants fence late approval/effects', async () => {
  const fixture = await botHandoffHttpFixture();
  try {
    fixture.setModel(() => ({
      tool: {
        name: 'create_approved_artifact',
        arguments: { content: 'OWNER_ONLY_APPROVAL_CONTENT' },
      },
    }));
    const { groupId, memberId } = await fixture.createGroup([
      'create_approved_artifact',
    ]);
    const password = fixture.credentials.password;
    for (const username of ['invited_user', 'outsider_admin'])
      expect(
        (
          await fixture.call('/api/admin/users', 'POST', {
            username,
            password,
            role: 'admin',
            must_change_password: false,
          })
        ).status,
      ).toBe(201);
    const login = async (username: string) => {
      const response = await fetch(fixture.origin + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      expect(response.status).toBe(200);
      return response.headers.get('set-cookie')!.split(';')[0];
    };
    const memberCookie = await login('invited_user'),
      outsiderCookie = await login('outsider_admin');
    const as = async (
      cookie: string,
      url: string,
      method = 'GET',
      body?: unknown,
    ) =>
      fetch(fixture.origin + url, {
        method,
        headers: {
          cookie,
          'content-type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    let state = await fixture.snapshot(groupId);
    expect(
      (
        await fixture.call(`/api/bot-groups/${groupId}/members`, 'POST', {
          kind: 'user',
          username: 'invited_user',
          role: 'member',
          expected_revision: state.revision,
        })
      ).status,
    ).toBe(200);
    expect(
      (await as(outsiderCookie, `/api/bot-groups/${groupId}`)).status,
    ).toBe(404);
    expect(
      (
        await as(memberCookie, `/api/bot-groups/${groupId}/messages`, 'POST', {
          content: '@Chief A member cannot spend Owner authorization.',
        })
      ).status,
    ).toBe(202);
    expect((await fixture.snapshot(groupId)).handoffs).toHaveLength(0);
    expect(fixture.requests).toHaveLength(0);
    await fixture.json(
      await fixture.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: '@Chief Prepare one approval-bound effect.',
      }),
    );
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state ===
        'waiting_for_approval',
    );
    state = await fixture.snapshot(groupId);
    const handoff = state.handoffs![0],
      base = `/api/bot-groups/${groupId}/handoffs/${handoff.id}`,
      { approvals } = await fixture.json<{
        approvals: { id: string; parameters_digest: string }[];
      }>(await fixture.call(base + '/approvals'));
    expect((await as(memberCookie, base + '/approvals')).status).toBe(404);
    expect(
      (
        await as(memberCookie, base + '/control', 'POST', {
          action: 'cancel',
          expected_revision: handoff.revision,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(
          memberCookie,
          `/api/bot-groups/${groupId}/members/${memberId}/runtime-grants`,
          'POST',
          {
            expected_revision: state.revision,
            expected_member_revision: state.members.find(
              (m) => m.id === memberId,
            )!.revision,
            runtime_kind: 'node-durable',
          },
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await fixture.call(
          `/api/bot-groups/${groupId}/members/${memberId}`,
          'PATCH',
          { state: 'disabled', expected_revision: state.revision },
        )
      ).status,
    ).toBe(200);
    await waitFor(
      async () =>
        (await fixture.snapshot(groupId)).handoffs![0].state === 'uncertain',
    );
    expect(
      (
        await fixture.call(base + '/approvals/' + approvals[0].id, 'POST', {
          parameters_digest: approvals[0].parameters_digest,
          decision: 'approve',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      fs.existsSync(
        path.join(
          fixture.root,
          'data/db/private-artifacts',
          approvals[0].id + '.txt',
        ),
      ),
    ).toBe(false);
    const db = new Database(path.join(fixture.root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        db
          .prepare('SELECT state FROM product_approvals WHERE id=?')
          .get(approvals[0].id),
      ).toEqual({ state: 'denied' });
    } finally {
      db.close();
    }
    await fixture.stop('SIGKILL');
    await fixture.start();
    await delay(600);
    expect(fixture.requests).toHaveLength(1);
    expect(
      (await fixture.snapshot(groupId)).messages.filter(
        (m) => m.author_kind === 'bot',
      ),
    ).toHaveLength(0);
  } catch (error) {
    throw new Error(String(error) + '\n' + fixture.diagnostics());
  } finally {
    await fixture.dispose();
  }
}, 420000);
