import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('real model completes three private turns through the mobile UI', async ({
  page,
}) => {
  test.setTimeout(480000);
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
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const dot = await f.json<any>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: '手机单聊验收',
        avatar_shape: 'clover',
        avatar_color: '#10b981',
        identity_prompt: '',
      }),
    );
    f.setModel(() => {
      throw new Error('Synthetic fallback forbidden');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.goto(`${f.origin}/bots?profile=${dot.profile.id}`);
    const prompts = [
      '记住我们的账本：初始余额是 100。只回答当前余额。',
      '在刚才余额基础上增加 20。只回答当前余额。',
      '在前面的余额基础上减少 5。只回答当前余额。',
    ];
    const expected = ['100', '120', '115'];
    const timeline = page.locator('[data-conversation-timeline] [data-index]');
    fs.mkdirSync(evidenceDir!, { recursive: true });
    for (let i = 0; i < prompts.length; i++) {
      await page.getByRole('textbox').fill(prompts[i]!);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '停止当前运行', exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        page.getByRole('button', { name: '发送消息', exact: true }),
      ).toBeVisible({ timeout: 180000 });
      await expect
        .poll(() => timeline.count(), { timeout: 180000 })
        .toBeGreaterThanOrEqual((i + 1) * 2);
      await expect(timeline.last()).toContainText(expected[i]!, {
        timeout: 180000,
      });
      await expect(
        page.getByText(expected[i]!, { exact: true }).last(),
      ).toBeVisible({ timeout: 180000 });
      await page.screenshot({
        path: path.join(evidenceDir!, `single-round-${i + 1}.png`),
      });
    }
    expect(f.requests).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await f.dispose();
  }
});
