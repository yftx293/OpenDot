// Optional real-provider acceptance. Requires an explicit isolated model config.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  botHandoffHttpFixture,
  waitFor,
} from '../../../tests/helpers/bot-handoff-http-fixture';
import { threeDotGroup } from '../../../tests/helpers/group-discussion-fixture';

test('real model completes three group rounds through the mobile UI', async ({
  page,
}) => {
  test.setTimeout(600000);
  const configPath = process.env.MINICLAW_GROUP_MODEL_CONFIG;
  const evidenceDir = process.env.MINICLAW_GROUP_UI_EVIDENCE_DIR;
  test.skip(
    !configPath || !evidenceDir,
    'requires explicit real model and evidence paths',
  );
  const model = JSON.parse(fs.readFileSync(configPath!, 'utf8'));
  const f = await botHandoffHttpFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (
      response.url().startsWith(f.origin + '/api/') &&
      response.status() >= 400
    )
      errors.push(
        `HTTP ${response.status()} ${new URL(response.url()).pathname}`,
      );
  });
  try {
    const providers = await f.json<any>(
      await f.call('/api/config/claude/providers'),
    );
    const id = providers.defaultProviderId ?? providers.providers[0].id;
    await f.json(
      await f.call(`/api/config/claude/providers/${id}`, 'PATCH', {
        name: 'Isolated real-model mobile acceptance',
        anthropicBaseUrl: model.baseUrl,
        anthropicModel: model.model,
        customEnv: {
          MINICLAW_MODEL_API: model.api,
          MINICLAW_MODEL_MAX_OUTPUT_TOKENS: '8192',
        },
      }),
    );
    await f.json(
      await f.call(`/api/config/claude/providers/${id}/secrets`, 'PUT', {
        anthropicApiKey: model.apiKey,
      }),
    );
    f.setModel(() => {
      throw new Error('Synthetic fallback forbidden');
    });
    const { groupId, people } = await threeDotGroup(
      f,
      'node-durable',
      [],
      'relay-v1',
    );
    const initial = await f.snapshot(groupId);
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/discussion-settings`, 'PATCH', {
        enabled: true,
        policy: 'relay-v1',
        coordinator_profile_id: people[0]!.id,
        participant_profile_ids: people.map((person) => person.id),
        max_turns: 3,
        max_turns_per_dot: 1,
        max_model_attempts: 24,
        expected_revision: initial.revision,
      }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(`${f.origin}/bot-groups/${groupId}`);
    const prompts = [
      '测试共享账本：初始预算 100。请 Researcher、Developer、Reviewer 按此顺序各发言一次，每人写明当前预算，协调者最后汇总。严格按当前 JSON 契约。',
      '延续上轮账本，预算增加 20。请 Researcher、Developer、Reviewer 依次发言并读取之前回复，每人写明当前预算，协调者最后汇总。严格按当前 JSON 契约。',
      '延续前两轮账本，预算减少 5。请 Researcher、Developer、Reviewer 依次发言并读取之前回复，每人写明当前预算，协调者最后汇总。严格按当前 JSON 契约。',
    ];
    let previousRun = '';
    fs.mkdirSync(evidenceDir!, { recursive: true });
    for (let i = 0; i < prompts.length; i++) {
      const before = await f.snapshot(groupId);
      const known = new Set(before.messages.map((message: any) => message.id));
      await page.getByLabel('群聊消息', { exact: true }).fill(prompts[i]!);
      await page
        .getByRole('button', { name: '发送群聊消息', exact: true })
        .click();
      await waitFor(async () => {
        const snapshot = await f.snapshot(groupId);
        const run = snapshot.discussion?.run;
        if (!run || run.id === previousRun) return false;
        if (['failed', 'waiting_user', 'cancelled'].includes(run.status))
          throw new Error(`round ${i + 1}: ${run.status}`);
        return run.status === 'completed';
      }, 180000);
      const snapshot = await f.snapshot(groupId);
      previousRun = snapshot.discussion!.run!.id;
      const replies = snapshot.messages.filter(
        (message: any) =>
          message.author_kind === 'bot' && !known.has(message.id),
      );
      expect(replies).toHaveLength(4);
      expect(
        replies.slice(0, 3).map((message: any) => message.author_id),
      ).toEqual(people.map((person) => person.id));
      const value = ['100', '120', '115'][i]!;
      for (const reply of replies)
        expect(reply.content).toMatch(new RegExp(`(^|\\D)${value}(?!\\d)`));
      await expect(
        page
          .getByText(replies[replies.length - 1]!.content, { exact: false })
          .first(),
      ).toBeVisible();
      await page.screenshot({
        path: path.join(evidenceDir!, `group-round-${i + 1}.png`),
      });
    }
    expect(f.requests).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});
