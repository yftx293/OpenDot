import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('mobile provider editor saves and restores the durable output limit', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const f = await botHandoffHttpFixture();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    await f.json(
      await f.call('/api/config/claude/providers', 'POST', {
        name: 'Output limit fixture',
        type: 'third_party',
        anthropicBaseUrl: 'http://127.0.0.1:1234/v1',
        anthropicApiKey: 'synthetic-secret',
        anthropicModel: 'fixture-model',
        customEnv: {
          MINICLAW_MODEL_API: 'openai-completions',
          TEST_OTHER: 'preserved',
        },
      }),
    );
    expect(
      (
        await context.request.post(f.origin + '/api/auth/login', {
          data: f.credentials,
        })
      ).status(),
    ).toBe(200);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(f.origin + '/settings?tab=claude');
    const card = page
      .locator('div.px-4.py-3')
      .filter({ hasText: 'Output limit fixture' });
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('summary').filter({ hasText: '高级设置' }).click();
    const limit = dialog.getByLabel('持久对话的模型输出上限（token）');
    await expect(limit).toHaveValue('');
    await limit.fill('8192');
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'PATCH' &&
        r.url().includes('/api/config/claude/providers/'),
    );
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    const saved = await response;
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON().customEnv).toMatchObject({
      MINICLAW_MODEL_MAX_OUTPUT_TOKENS: '8192',
      MINICLAW_MODEL_API: 'openai-completions',
      TEST_OTHER: 'preserved',
    });
    await expect(dialog).toBeHidden();
    await card.getByRole('button', { name: '编辑', exact: true }).click();
    await page
      .getByRole('dialog')
      .locator('summary')
      .filter({ hasText: '高级设置' })
      .click();
    await expect(
      page.getByLabel('持久对话的模型输出上限（token）'),
    ).toHaveValue('8192');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await f.dispose();
  }
});
