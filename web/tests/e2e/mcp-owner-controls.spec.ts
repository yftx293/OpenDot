import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('mobile owner configures exact Node Session MCP startup in the real product UI', async ({
  browser,
}) => {
  test.setTimeout(150000);
  const fixture = await botHandoffHttpFixture(undefined, {
    MINICLAW_PI_MCP: 'true',
  });
  const ledger = path.join(fixture.root, 'browser-mcp-effects.jsonl');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/mcp') && response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  try {
    await fixture.json(
      await fixture.call('/api/config/system', 'PUT', {
        providerSetupSkipped: true,
      }),
    );
    const options = await fixture.json<{ workspaces: { jid: string }[] }>(
      await fixture.call('/api/bot-groups/options'),
    );
    const jid = options.workspaces[0].jid;
    const groups = await fixture.json<{
      groups: Record<string, { folder: string }>;
    }>(await fixture.call('/api/groups'));
    await fixture.json(
      await fixture.call('/api/mcp-servers', 'POST', {
        id: 'browser_fixture',
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL(
              '../../../tests/fixtures/mcp-managed-server.mjs',
              import.meta.url,
            ),
          ),
        ],
        env: { MCP_TEST_LEDGER: ledger },
        pi: {
          version: 1,
          enabled: true,
          location: { kind: 'host' },
          tools: ['echo'],
        },
      }),
    );
    const created = await fixture.json<{ session: { id: string } }>(
      await fixture.call(
        `/api/groups/${encodeURIComponent(jid)}/sessions`,
        'POST',
        { name: 'Mobile MCP owner', runtime: 'node-durable' },
      ),
    );
    expect(fs.existsSync(ledger)).toBe(false);
    expect(
      (
        await context.request.post(fixture.origin + '/api/auth/login', {
          data: fixture.credentials,
        })
      ).status(),
    ).toBe(200);
    await page.goto(
      `${fixture.origin}/chat/${encodeURIComponent(groups.groups[jid].folder)}?agent=${created.session.id}`,
    );
    const tools = page.getByRole('region', { name: '外部工具授权' });
    await expect(tools).toBeVisible();
    await tools.getByText('本会话的外部工具').click();
    await expect(tools.getByLabel('外部工具服务')).toBeVisible();
    await tools.getByLabel('外部工具服务').selectOption('browser_fixture');
    await tools.getByLabel('echo').check();
    await tools
      .getByRole('checkbox', {
        name: /允许服务端启动此服务/,
      })
      .check();
    await tools.getByRole('button', { name: '授权所选工具' }).click();
    await expect(
      tools.getByText(/已授权所选工具|未确认服务启动/),
    ).toBeVisible();
    const sessionOptions = await fixture.json<{
      consents: { state: string }[];
    }>(
      await fixture.call(
        `/api/groups/${encodeURIComponent(jid)}/sessions/${created.session.id}/mcp`,
      ),
    );
    if (sessionOptions.consents.at(-1)?.state !== 'active')
      throw new Error(
        `Mobile startup was ${sessionOptions.consents.at(-1)?.state}: ${fixture.diagnostics().slice(-8000)}`,
      );
    await expect(tools.getByText(/已授权所选工具/)).toBeVisible();
    expect(errors).toEqual([]);
    expect(fs.readFileSync(ledger, 'utf8')).toContain('"event":"start"');
    await page.screenshot({
      path: test.info().outputPath('mobile-mcp-session-consent.png'),
      animations: 'disabled',
    });
  } finally {
    await context.close();
    await fixture.dispose();
  }
});
