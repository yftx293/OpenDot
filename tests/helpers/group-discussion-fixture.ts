import {
  botHandoffHttpFixture,
  type ModelBody,
} from './bot-handoff-http-fixture.js';
export function groupInputContext(body: ModelBody): any {
  let value: any = body.messages
    .filter((m) => m.role === 'user')
    .at(-1)?.content;
  for (let i = 0; i < 8; i++) {
    if (Array.isArray(value)) value = value.map((v) => v.text ?? '').join('');
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        break;
      }
    }
    if (
      value?.kind === 'group_discussion_context' ||
      value?.kind === 'group_member_input' ||
      value?.kind === 'bot_group_request'
    )
      return value;
    if (value?.content) value = value.content;
  }
  throw new Error('Expected a canonical group discussion context');
}
export function turnContext(body: ModelBody): any {
  const value = groupInputContext(body);
  if (value.kind !== 'group_discussion_context')
    throw new Error('Expected a canonical group discussion context');
  return value;
}
export async function threeDotGroup(
  f: Awaited<ReturnType<typeof botHandoffHttpFixture>>,
  runtimeKind: 'node-durable' | 'cloudflare-durable' = 'node-durable',
  tools: string[] = [],
  policy: 'coordinator-v1' | 'relay-v1' = 'coordinator-v1',
  personas?: Record<string, string>,
) {
  const base = await f.createGroup(tools, 4, runtimeKind);
  const people: { id: string; name: string; jid: string }[] = [];
  for (const name of ['Researcher', 'Developer', 'Reviewer']) {
    const created = await f.json<any>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: crypto.randomUUID(),
        name,
        avatar_shape: 'blob',
        avatar_color: '#1456f0',
        identity_prompt:
          personas?.[name] ??
          `You are ${name}. Discuss the user's question using only authorized Group context. Keep public replies concise.`,
      }),
    );
    people.push({ id: created.profile.id, name, jid: created.jid });
    let snapshot = await f.snapshot(base.groupId);
    snapshot = (
      await f.json<any>(
        await f.call(`/api/bot-groups/${base.groupId}/members`, 'POST', {
          kind: 'bot',
          profile_id: created.profile.id,
          scope_workspace_jid: created.jid,
          expected_revision: snapshot.revision,
        }),
      )
    ).snapshot;
    const member = snapshot.members.find(
      (m: any) => m.subject_id === created.profile.id,
    )!;
    await f.json(
      await f.call(
        `/api/bot-groups/${base.groupId}/members/${member.id}/runtime-grants`,
        'POST',
        {
          runtime_kind: runtimeKind,
          max_model_attempts: 4,
          tool_capabilities: tools,
          expected_revision: snapshot.revision,
          expected_member_revision: member.revision,
        },
      ),
    );
  }
  const snapshot = await f.snapshot(base.groupId);
  await f.json(
    await f.call(
      `/api/bot-groups/${base.groupId}/discussion-settings`,
      'PATCH',
      {
        enabled: true,
        policy,
        coordinator_profile_id: people[0].id,
        participant_profile_ids: people.map((p) => p.id),
        expected_revision: snapshot.revision,
      },
    ),
  );
  return { groupId: base.groupId, people };
}
