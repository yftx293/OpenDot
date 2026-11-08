import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('one navigation surface creates a Dot, finds existing Dots and switches old and other conversations', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const f = await botHandoffHttpFixture();
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const savedName = '资料整理助手（长期项目方案与资料）';
    const saved = await f.json<{
      profile: { id: string };
      jid: string;
      folder: string;
    }>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: savedName,
        avatar_shape: 'star',
        avatar_color: '#3b82f6',
        identity_prompt: '',
      }),
    );
    const old = await f.json<{ agent: { id: string } }>(
      await f.call(
        `/api/groups/${encodeURIComponent(saved.jid)}/agents`,
        'POST',
        { name: '上周的方案讨论' },
      ),
    );
    const other = await f.json<{ jid: string; group: { folder: string } }>(
      await f.call('/api/groups', 'POST', {
        name: '之前的项目对话',
        execution_mode: 'host',
      }),
    );
    for (const width of [320, 390, 1100, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 768,
        hasTouch: width < 768,
        colorScheme: width === 1440 ? 'dark' : 'light',
      });
      try {
        await context.addInitScript(() => {
          if (location.origin !== 'null')
            localStorage.setItem('miniclaw-theme', 'system');
        });
        expect(
          (
            await context.request.post(f.origin + '/api/auth/login', {
              data: f.credentials,
            })
          ).status(),
        ).toBe(200);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.name));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push('console-error');
        });
        page.on('response', (response) => {
          if (response.status() >= 400)
            errors.push(
              new URL(response.url()).pathname + ':' + response.status(),
            );
        });
        await page.goto(f.origin + '/bots');
        await expect(page.getByPlaceholder('输入消息...')).toBeVisible();
        if (width === 1440)
          await expect(page.locator('html')).toHaveClass(/dark/);
        const mainUrl = page.url();
        const open = async () => {
          await page
            .getByRole('button', { name: 'Dot 和对话', exact: true })
            .click();
        };
        const panel = page.locator('[data-conversation-navigation]');
        const checkSurface = async () => {
          await expect(panel).toBeVisible();
          await expect(panel).toHaveAttribute('data-side', 'left');
          await expect(page.getByRole('dialog')).toHaveCount(1);
          await expect.poll(async () => (await panel.boundingBox())?.x).toBe(0);
          const bounds = (await panel.boundingBox())!;
          expect(bounds.x).toBe(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          expect(
            await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
        };
        if (width < 768) {
          const quickCreate = page.getByRole('button', {
            name: '新建 Dot',
            exact: true,
          });
          await expect(quickCreate.locator('svg.lucide-plus')).toBeVisible();
          await quickCreate.click();
          await expect(panel).toHaveAccessibleName('创建新 Dot');
          await panel
            .getByRole('button', { name: '关闭新建 Dot', exact: true })
            .click();
        }
        await open();
        await checkSurface();
        await panel
          .getByRole('button', { name: '新建 Dot', exact: true })
          .click();
        await expect(panel).toHaveAccessibleName('创建新 Dot');
        await checkSurface();
        await expect(
          panel.getByLabel('Dot 名称', { exact: true }),
        ).toBeFocused();
        await panel
          .getByLabel('Dot 名称', { exact: true })
          .fill('导航测试 ' + width);
        // Both creation types are discoverable from the + entry without
        // returning to the conversation list, and switching retains each draft.
        await expect(
          panel.getByRole('button', { name: '新建群聊', exact: true }),
        ).toBeVisible();
        await panel
          .getByRole('button', { name: '新建群聊', exact: true })
          .click();
        await panel
          .getByLabel('群聊名称', { exact: true })
          .fill('草稿小队 ' + width);
        await panel
          .getByRole('checkbox', { name: savedName, exact: true })
          .check();
        await panel
          .getByRole('button', { name: '新建 Dot', exact: true })
          .click();
        await expect(panel.getByLabel('Dot 名称', { exact: true })).toHaveValue(
          '导航测试 ' + width,
        );
        await panel
          .getByRole('button', { name: '新建群聊', exact: true })
          .click();
        await expect(panel.getByLabel('群聊名称', { exact: true })).toHaveValue(
          '草稿小队 ' + width,
        );
        await expect(
          panel.getByRole('checkbox', { name: savedName, exact: true }),
        ).toBeChecked();
        await panel
          .getByRole('button', { name: '新建 Dot', exact: true })
          .click();
        if (width < 768) {
          await page.setViewportSize({ width, height: 480 });
          await expect(
            panel.getByRole('button', { name: '创建并开始对话', exact: true }),
          ).toBeInViewport({ ratio: 1 });
          await page.setViewportSize({ width, height: 844 });
        }
        await page.screenshot({
          path: test.info().outputPath(`navigation-${width}-create.png`),
          animations: 'disabled',
        });
        await panel
          .getByRole('button', { name: '创建并开始对话', exact: true })
          .click();
        await expect(page).toHaveURL(/\/chat\/bot-[^?]+\?bot=/);
        await expect(panel).not.toBeVisible();
        const createdUrl = page.url();
        await open();
        await checkSurface();
        await page.screenshot({
          path: test.info().outputPath(`navigation-${width}-overview.png`),
          animations: 'disabled',
        });
        await panel
          .getByLabel('搜索 Dot 和对话', { exact: true })
          .fill('找不到的名字');
        await expect(
          panel.getByText('没有找到匹配的 Dot 或对话。', { exact: true }),
        ).toBeVisible();
        await panel
          .getByLabel('搜索 Dot 和对话', { exact: true })
          .fill(savedName);
        await expect(
          panel.getByRole('link', {
            name: savedName + '的历史对话',
            exact: true,
          }),
        ).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath(`navigation-${width}-find-dot.png`),
          animations: 'disabled',
        });
        await panel
          .getByRole('link', { name: savedName + '的历史对话', exact: true })
          .click();
        await expect(page).toHaveURL(
          new RegExp(
            '/chat/' +
              saved.folder +
              '\\?bot=' +
              saved.profile.id +
              '&sessions=1',
          ),
        );
        await expect(panel).toHaveAccessibleName('对话列表');
        await checkSurface();
        await expect(
          panel
            .getByRole('button')
            .filter({ has: page.getByText('上周的方案讨论', { exact: true }) }),
        ).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath(`navigation-${width}-history.png`),
          animations: 'disabled',
        });
        await panel
          .getByRole('button')
          .filter({ has: page.getByText('上周的方案讨论', { exact: true }) })
          .click();
        await expect(page).toHaveURL(new RegExp('agent=' + old.agent.id));
        await expect(panel).not.toBeVisible();
        // A deep-link/reload restores the same history surface, including on first mount.
        const historyUrl = new URL(page.url());
        historyUrl.searchParams.set('sessions', '1');
        await page.goto(historyUrl.href);
        await expect(panel).toHaveAccessibleName('对话列表');
        await checkSurface();
        await panel
          .getByRole('button', { name: '返回 Dot 和对话', exact: true })
          .click();
        await expect(panel).toHaveAccessibleName('Dot 和对话');
        await checkSurface();
        expect(new URL(page.url()).searchParams.get('agent')).toBe(
          old.agent.id,
        );
        await panel
          .getByLabel('搜索 Dot 和对话', { exact: true })
          .fill('之前的项目');
        await panel
          .getByRole('link', { name: /之前的项目对话/ })
          .filter({ hasText: '之前的项目对话' })
          .first()
          .click();
        await expect(page).toHaveURL(new RegExp('/chat/' + other.group.folder));
        await expect(panel).not.toBeVisible();
        await open();
        await checkSurface();
        await panel
          .getByRole('button', { name: '新建 Dot', exact: true })
          .click();
        await panel
          .getByRole('button', { name: '返回 Dot 和对话', exact: true })
          .click();
        await expect(panel).toHaveAccessibleName('Dot 和对话');
        await page.keyboard.press('Escape');
        await expect(panel).not.toBeVisible();
        await expect(
          page.getByRole('button', {
            name: 'Dot 和对话',
            exact: true,
          }),
        ).toBeFocused();
        // Native team groups share the same creation/navigation surface on phones.
        await open();
        await panel
          .getByRole('button', { name: '新建群聊', exact: true })
          .click();
        await expect(panel).toHaveAccessibleName('新建群聊');
        await checkSurface();
        await panel
          .getByLabel('群聊名称', { exact: true })
          .fill('导航小队 ' + width);
        await panel
          .getByRole('checkbox', { name: savedName, exact: true })
          .check();
        await expect(panel.getByRole('combobox')).toHaveCount(0);
        await expect(
          panel.getByRole('button', { name: '创建群聊', exact: true }),
        ).toBeEnabled();
        await page.screenshot({
          path: test.info().outputPath(`navigation-${width}-create-group.png`),
          animations: 'disabled',
        });
        if (width === 390) {
          await page.emulateMedia({ colorScheme: 'dark' });
          await expect(page.locator('html')).toHaveClass(/dark/);
          await page.screenshot({
            path: test
              .info()
              .outputPath('navigation-390-create-group-dark.png'),
            animations: 'disabled',
          });
          await page.emulateMedia({ colorScheme: 'light' });
        }
        await panel
          .getByRole('button', { name: '创建群聊', exact: true })
          .click();
        await expect(page).toHaveURL(/\/bot-groups\/[^/?]+$/);
        await expect(panel).not.toBeVisible();
        await expect(
          page.getByRole('heading', { name: '导航小队 ' + width, exact: true }),
        ).toBeVisible();
        const groupUrl = page.url();
        const groups = await f.json<{ groups: { id: string; name: string }[] }>(
          await f.call('/api/bot-groups'),
        );
        expect(
          groups.groups.filter((g) => g.name === '导航小队 ' + width),
        ).toHaveLength(1);
        const groupId = new URL(groupUrl).pathname.split('/').at(-1)!;
        const storedGroup = await f.snapshot(groupId);
        expect(
          storedGroup.members
            .filter((member) => member.kind === 'bot')
            .map((member) => member.subject_id),
        ).toContain(saved.profile.id);
        expect(
          storedGroup.members.filter((member) => member.kind === 'bot'),
        ).toHaveLength(2);
        expect(
          storedGroup.members
            .filter((member) => member.kind === 'bot')
            .every((member) => member.can_execute),
        ).toBe(true);
        // Group headers expose the same drawer instead of another directional overlay.
        await page
          .getByRole('button', { name: 'Dot 和对话', exact: true })
          .click();
        await checkSurface();
        await panel
          .getByLabel('搜索 Dot 和对话', { exact: true })
          .fill('导航小队 ' + width);
        await panel
          .getByRole('link', { name: new RegExp('导航小队 ' + width) })
          .click();
        await expect(panel).not.toBeVisible();
        expect(page.url()).toBe(groupUrl);
        expect(createdUrl).not.toBe(mainUrl);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test('desktop creation survives the default chat entry resolving after the drawer opens', async ({
  page,
}) => {
  test.setTimeout(240000);
  const f = await botHandoffHttpFixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.request.post(f.origin + '/api/auth/login', {
      data: f.credentials,
    });
    await page.route('**/api/agent-profiles/*/chat-entry', async (route) => {
      held = true;
      await barrier;
      await route.continue();
    });
    await page.goto(f.origin + '/bots');
    await expect.poll(() => held).toBe(true);
    await page.getByRole('button', { name: '新建 Dot', exact: true }).click();
    const panel = page.locator('[data-conversation-navigation]');
    await panel.getByRole('button', { name: '新建群聊', exact: true }).click();
    const form = panel.getByRole('form', { name: '新建群聊', exact: true });
    await form
      .getByRole('textbox', { name: '群聊名称', exact: true })
      .fill('保留建群草稿');
    release();
    await expect(page).toHaveURL(/\/chat\//);
    await expect(page.getByPlaceholder('输入消息...')).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(form).toBeVisible();
    await expect(
      form.getByRole('textbox', { name: '群聊名称', exact: true }),
    ).toHaveValue('保留建群草稿');
    await expect(
      form.getByRole('checkbox', { name: 'Miniclaw', exact: true }),
    ).toBeChecked();
    await expect(
      form.getByRole('button', { name: '创建群聊', exact: true }),
    ).toBeEnabled();
    expect(f.requests).toHaveLength(0);
  } finally {
    release();
    await f.dispose();
  }
});
