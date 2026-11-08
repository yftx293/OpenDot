import { expect, test } from 'vitest';
import { botHandoffHttpFixture } from './helpers/bot-handoff-http-fixture.js';

for (const mode of ['disabled', 'invalid-model'] as const) {
  test(`Group execution ${mode} is a confirmed rejection that leaves the Group editable`, async () => {
    const f = await botHandoffHttpFixture(undefined, {
      MINICLAW_DURABLE_RUNTIME: mode === 'disabled' ? 'false' : 'true',
    });
    try {
      if (mode === 'invalid-model') {
        const providers = await f.json<any>(
          await f.call('/api/config/claude/providers'),
        );
        const id = providers.defaultProviderId ?? providers.providers[0].id;
        await f.json(
          await f.call(`/api/config/claude/providers/${id}`, 'PATCH', {
            customEnv: { MINICLAW_MODEL_API: 'unsupported-fixture-api' },
          }),
        );
      }
      const options = await f.json<any>(
        await f.call('/api/bot-groups/options'),
      );
      let snapshot = (
        await f.json<any>(
          await f.call('/api/bot-groups', 'POST', {
            workspace_jid: options.workspaces[0].jid,
            name: 'Readiness rejection fixture',
          }),
        )
      ).snapshot;
      const member = snapshot.members.find((m: any) => m.kind === 'bot');
      snapshot = (
        await f.json<any>(
          await f.call(
            `/api/bot-groups/${snapshot.group.id}/members/${member.id}`,
            'PATCH',
            {
              scope_workspace_jid: options.workspaces[0].jid,
              expected_revision: snapshot.revision,
            },
          ),
        )
      ).snapshot;
      const response = await f.call(
        `/api/bot-groups/${snapshot.group.id}/members/${member.id}/runtime-grants`,
        'POST',
        {
          expected_revision: snapshot.revision,
          expected_member_revision: snapshot.members.find(
            (m: any) => m.id === member.id,
          ).revision,
          runtime_kind: 'node-durable',
          tool_capabilities: [],
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code:
          mode === 'disabled'
            ? 'BOT_HANDOFF_RUNTIME_DISABLED'
            : 'BOT_HANDOFF_RUNTIME_CONFIGURATION_UNAVAILABLE',
      });
      expect((await f.snapshot(snapshot.group.id)).revision).toBe(
        snapshot.revision,
      );
      const corrected = await f.json<any>(
        await f.call(`/api/bot-groups/${snapshot.group.id}`, 'PATCH', {
          expected_revision: snapshot.revision,
          name: 'Still editable after rejection',
        }),
      );
      expect(corrected.snapshot.group.name).toBe(
        'Still editable after rejection',
      );
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  }, 180000);
}
