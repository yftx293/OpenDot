import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import { turnContext } from './helpers/group-discussion-fixture.js';

const dockerHost = process.env.OPENDOT_TEST_DOCKER_HOST;
test.skipIf(!dockerHost)(
  'Docker-enabled quick Dot creation enters model-only Group discussion without converting workspaces to Host',
  async () => {
    const f = await botHandoffHttpFixture(undefined, {
      ADMIN_HOST_ONLY_MODE: 'false',
      DOCKER_HOST: dockerHost!,
    });
    let db: Database.Database | undefined;
    try {
      const dots = [];
      for (const name of ['Synthetic reviewer', 'Synthetic builder']) {
        dots.push(
          await f.json<any>(
            await f.call('/api/agent-profiles/quick-create', 'POST', {
              request_id: randomUUID(),
              name,
              avatar_shape: 'clover',
              avatar_color: '#10b981',
            }),
          ),
        );
      }
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      for (const dot of dots) {
        const row = db
          .prepare('SELECT execution_mode FROM registered_groups WHERE jid=?')
          .get(dot.jid) as { execution_mode: string };
        expect(row.execution_mode).toBe('container');
      }
      const created = await f.json<any>(
        await f.call('/api/bot-groups', 'POST', {
          name: 'Synthetic Docker group',
          bot_profile_ids: dots.map((dot) => dot.profile.id),
        }),
      );
      const groupId = created.snapshot.group.id;
      const snapshot = await f.snapshot(groupId);
      await f.json(
        await f.call(
          `/api/bot-groups/${groupId}/discussion-settings`,
          'PATCH',
          {
            enabled: true,
            coordinator_profile_id: dots[0].profile.id,
            participant_profile_ids: dots.map((dot) => dot.profile.id),
            expected_revision: snapshot.revision,
          },
        ),
      );
      f.setModel((body) => {
        const c = turnContext(body);
        if (c.speaker_contract.role === 'speaker')
          return {
            text: JSON.stringify({
              action: 'reply',
              message: 'SYNTHETIC_DOT_REPLY',
            }),
          };
        return {
          text: JSON.stringify(
            c.turn_count === 0
              ? { action: 'speak', profileId: dots[1].profile.id }
              : { action: 'finish', summary: 'SYNTHETIC_DONE' },
          ),
        };
      });
      await f.json(
        await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
          content: 'Synthetic question',
        }),
      );
      await waitFor(
        async () =>
          (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
        60000,
      );
      expect(f.requests.length).toBeGreaterThan(0);
      const final = await f.snapshot(groupId);
      expect(
        final.messages.some((m) => m.content === 'SYNTHETIC_DOT_REPLY'),
      ).toBe(true);
      for (const dot of dots)
        expect(
          (
            db
              .prepare(
                'SELECT execution_mode FROM registered_groups WHERE jid=?',
              )
              .get(dot.jid) as { execution_mode: string }
          ).execution_mode,
        ).toBe('container');
      const grants = db
        .prepare(
          `SELECT tool_capabilities FROM bot_group_runtime_grants WHERE group_id=?`,
        )
        .all(groupId) as { tool_capabilities: string }[];
      expect(grants.length).toBeGreaterThan(0);
      expect(
        grants.every((g) => JSON.parse(g.tool_capabilities).length === 0),
      ).toBe(true);
    } finally {
      db?.close();
      await f.dispose();
    }
  },
  120000,
);

test.skipIf(!dockerHost)(
  'a member without Host execution creates container Dots and starts model-only Group discussion',
  async () => {
    const f = await botHandoffHttpFixture(undefined, {
      ADMIN_HOST_ONLY_MODE: 'false',
      DOCKER_HOST: dockerHost!,
    });
    let db: Database.Database | undefined;
    try {
      const username = 'synthetic_member';
      const user = await f.json<any>(
        await f.call('/api/admin/users', 'POST', {
          username,
          password: f.credentials.password,
          role: 'member',
          must_change_password: false,
        }),
      );
      const login = await fetch(f.origin + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: f.credentials.password }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const call = async (url: string, method = 'GET', body?: unknown) =>
        fetch(f.origin + url, {
          method,
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const dots = [];
      for (const name of ['Member reviewer', 'Member builder'])
        dots.push(
          await f.json<any>(
            await call('/api/agent-profiles/quick-create', 'POST', {
              request_id: randomUUID(),
              name,
              avatar_shape: 'star',
              avatar_color: '#3b82f6',
            }),
          ),
        );
      db = new Database(path.join(f.root, 'data/db/messages.db'), {
        readonly: true,
      });
      for (const dot of dots)
        expect(
          (
            db
              .prepare(
                'SELECT execution_mode FROM registered_groups WHERE jid=?',
              )
              .get(dot.jid) as { execution_mode: string }
          ).execution_mode,
        ).toBe('container');
      const created = await f.json<any>(
        await call('/api/bot-groups', 'POST', {
          name: 'Member group',
          bot_profile_ids: dots.map((dot) => dot.profile.id),
        }),
      );
      const id = created.snapshot.group.id;
      const revision = created.snapshot.revision;
      const configured = await call(
        `/api/bot-groups/${id}/discussion-settings`,
        'PATCH',
        {
          enabled: true,
          coordinator_profile_id: dots[0].profile.id,
          participant_profile_ids: dots.map((dot) => dot.profile.id),
          expected_revision: revision,
        },
      );
      expect(configured.status).toBe(200);
      f.setModel((body) => {
        const context = turnContext(body);
        if (context.speaker_contract.role === 'speaker')
          return {
            text: JSON.stringify({
              action: 'reply',
              message: 'SYNTHETIC_MEMBER_REPLY',
            }),
          };
        return {
          text: JSON.stringify(
            context.turn_count === 0
              ? { action: 'speak', profileId: dots[1].profile.id }
              : { action: 'finish', summary: 'SYNTHETIC_MEMBER_DONE' },
          ),
        };
      });
      await f.json(
        await call(`/api/bot-groups/${id}/messages`, 'POST', {
          content: 'Synthetic member question',
        }),
      );
      let completed: any;
      await waitFor(async () => {
        completed = await f.json<any>(await call(`/api/bot-groups/${id}`));
        return completed.discussion?.run?.status === 'completed';
      }, 60000);
      expect(
        completed.messages.some(
          (message: { content: string }) =>
            message.content === 'SYNTHETIC_MEMBER_REPLY',
        ),
      ).toBe(true);
      const grants = db
        .prepare(
          'SELECT tool_capabilities FROM bot_group_runtime_grants WHERE group_id=?',
        )
        .all(id) as { tool_capabilities: string }[];
      expect(grants.length).toBeGreaterThan(0);
      expect(
        grants.every(
          (grant) => JSON.parse(grant.tool_capabilities).length === 0,
        ),
      ).toBe(true);
      const owner = db.prepare('SELECT role,status FROM users WHERE id=?')
        .get(user.user.id) as { role: string; status: string };
      expect(owner).toEqual({ role: 'member', status: 'active' });
      for (const dot of dots) {
        const workspace = db.prepare(
          'SELECT execution_mode,created_by FROM registered_groups WHERE jid=?',
        ).get(dot.jid) as { execution_mode: string; created_by: string };
        expect(workspace).toEqual({
          execution_mode: 'container',
          created_by: user.user.id,
        });
      }
    } finally {
      db?.close();
      await f.dispose();
    }
  },
  120000,
);
