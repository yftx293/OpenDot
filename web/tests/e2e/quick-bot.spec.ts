import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('quick Bot creation reaches its first chat at desktop/mobile widths and survives a lost creation ACK', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const fixture = await botHandoffHttpFixture();
  let reply = '',
    requests = 0;
  // Main conversations use Anthropic Messages; the Handoff fixture's default
  // OpenAI provider is intentionally for the separate Durable Group path.
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    const message = {
      id: 'quick-dot-model',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 0 },
    };
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ...message,
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
        }),
      );
      return;
    }
    const event = (type: string, value: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      event('message_start', { message }) +
        event('content_block_start', {
          index: 0,
          content_block: { type: 'text', text: '' },
        }) +
        event('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: reply },
        }) +
        event('content_block_stop', { index: 0 }) +
        event('message_delta', {
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 },
        }) +
        event('message_stop', {}),
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  try {
    const configured = await fixture.json<{ id: string }>(
      await fixture.call('/api/config/claude/providers', 'POST', {
        name: 'Quick conversation model',
        enabled: true,
        type: 'third_party',
        anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        anthropicApiKey: 'synthetic-quick-conversation-key',
        anthropicModel: 'fixture-model',
      }),
    );
    await fixture.json(
      await fixture.call('/api/config/claude/default', 'PUT', {
        providerId: configured.id,
      }),
    );
    await fixture.json(
      await fixture.call('/api/config/system', 'PUT', {
        providerSetupSkipped: true,
      }),
    );
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
        colorScheme: width === 1440 ? 'dark' : 'light',
      });
      try {
        expect(
          (
            await context.request.post(fixture.origin + '/api/auth/login', {
              data: fixture.credentials,
            })
          ).status(),
        ).toBe(200);
        const page = await context.newPage();
        const errors: { path: string; status: number }[] = [];
        page.on('response', (response) => {
          if (response.status() >= 400)
            errors.push({
              path: new URL(response.url()).pathname,
              status: response.status(),
            });
        });
        await page.goto(fixture.origin + '/agent-profiles?create=1');
        const dialog = page.getByRole('dialog', {
          name: '创建新 Dot',
          exact: true,
        });
        const create = dialog.getByRole('button', {
          name: '创建并开始对话',
          exact: true,
        });
        await expect(
          dialog.getByLabel('Dot 名称', { exact: true }),
        ).toBeFocused();
        await expect(create).toBeDisabled();
        await dialog.getByLabel('Dot 名称', { exact: true }).fill('  ');
        await expect(create).toBeDisabled();
        const name = 'Quick Dot ' + width;
        await dialog.getByLabel('Dot 名称', { exact: true }).fill(name);
        await dialog
          .getByRole('button', { name: '星形形状', exact: true })
          .click();
        await dialog
          .getByRole('button', { name: '蓝色头像', exact: true })
          .click();
        await expect(dialog.locator('.bot-avatar')).toHaveAttribute(
          'data-avatar-shape',
          'star',
        );
        for (const button of await dialog.getByRole('button').all()) {
          const bounds = await button.boundingBox();
          if (bounds) {
            expect(bounds.width).toBeGreaterThanOrEqual(44);
            expect(bounds.height).toBeGreaterThanOrEqual(44);
          }
        }
        const submitBounds = (await create.boundingBox())!;
        expect(submitBounds.y + submitBounds.height).toBeLessThanOrEqual(844);
        await page.screenshot({
          path: test.info().outputPath(`quick-dot-${width}.png`),
          animations: 'disabled',
        });
        if (width < 768) {
          await page.setViewportSize({ width, height: 480 });
          await expect(create).toBeInViewport({ ratio: 1 });
          await page.screenshot({
            path: test
              .info()
              .outputPath(`quick-dot-${width}-short-viewport.png`),
            animations: 'disabled',
          });
          await page.setViewportSize({ width, height: 844 });
        }
        let lost = false;
        if (width === 390)
          await page.route(
            '**/api/agent-profiles/quick-create',
            async (route) => {
              if (!lost) {
                lost = true;
                await route.fetch();
                await route.abort('failed');
              } else await route.continue();
            },
          );
        await create.click();
        if (width === 390) {
          await expect(dialog.getByRole('alert')).toBeVisible();
          await page.reload();
          await page.goto(fixture.origin + '/agent-profiles?create=1');
          await expect(
            dialog.getByLabel('Dot 名称', { exact: true }),
          ).toHaveValue(name);
          await dialog
            .getByRole('button', { name: '重试并开始对话', exact: true })
            .click();
        }
        await expect(page).toHaveURL(/\/chat\/bot-[^?]+\?bot=/);
        const profiles = await fixture.json<{
          profiles: { id: string; name: string; avatar_shape: string }[];
        }>(await fixture.call('/api/agent-profiles'));
        const matches = profiles.profiles.filter(
          (profile) => profile.name === name,
        );
        expect(matches).toHaveLength(1);
        expect(matches[0].avatar_shape).toBe('star');
        const id = matches[0].id;
        expect(new URL(page.url()).searchParams.get('bot')).toBe(id);
        await expect(
          page.locator(`.bot-avatar[data-bot-id="${id}"]`).first(),
        ).toHaveAttribute('data-avatar-shape', 'star');
        reply = 'QUICK_DOT_REPLY_' + width;
        const before = requests;
        await page
          .getByPlaceholder('输入消息...')
          .fill('Acknowledge this new conversation.');
        await page
          .getByRole('button', { name: '发送消息', exact: true })
          .click();
        await expect(
          page.getByText('QUICK_DOT_REPLY_' + width, { exact: true }),
        ).toBeVisible({ timeout: 45000 });
        expect(requests).toBeGreaterThan(before);
        const available = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/goals/availability',
        );
        await page.goto(fixture.origin + '/bots?view=team');
        expect((await (await available).json()).enabled).toBe(false);
        await expect(
          page.getByRole('button', { name, exact: true }),
        ).toBeVisible();
        await expect(
          page
            .getByRole('article')
            .filter({ has: page.getByRole('button', { name, exact: true }) })
            .getByRole('button', { name: '开始对话', exact: true }),
        ).toBeVisible();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await fixture.dispose();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
