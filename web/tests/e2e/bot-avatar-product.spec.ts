// Actual product HTTP/SQLite/native Pi Durable execution. Inference is a fixture;
// mobile/tablet are Chromium emulation, never a physical-device performance claim.
import { expect, test, type Page } from '@playwright/test';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';
import { openGroupApproval, closeGroupWork } from './group-work-helpers';

test('Bot identity follows real work across Chief, contacts, Group, attention and responsive Context without submitting on reconnect', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const f = await botHandoffHttpFixture(undefined, {
    MINICLAW_PERSONAL_GOALS: 'true',
  });
  const contexts = [];
  try {
    await f.json(
      await f.call('/api/config/system', 'PUT', { providerSetupSkipped: true }),
    );
    const group = await f.createGroup();
    const profiles: Record<string, string> = {};
    for (const name of ['Researcher', 'Developer']) {
      const { profile } = await f.json<{ profile: { id: string } }>(
        await f.call('/api/agent-profiles', 'POST', {
          name,
          identity_prompt: 'Perform only the explicitly authorized task.',
          ...(name === 'Developer'
            ? { avatar_emoji: '🐙', avatar_color: '#7f93ad' }
            : {}),
        }),
      );
      profiles[name] = profile.id;
      const workspace = await f.json<{ jid: string }>(
        await f.call('/api/groups', 'POST', {
          name: name + ' workspace',
          agent_profile_id: profile.id,
          execution_mode: 'host',
        }),
      );
      let snapshot = await f.snapshot(group.groupId);
      await f.json(
        await f.call(`/api/bot-groups/${group.groupId}/members`, 'POST', {
          kind: 'bot',
          profile_id: profile.id,
          scope_workspace_jid: workspace.jid,
          expected_revision: snapshot.revision,
        }),
      );
      if (name === 'Researcher') {
        snapshot = await f.snapshot(group.groupId);
        const member = snapshot.members.find(
          (m) => m.subject_id === profile.id,
        )!;
        await f.json(
          await f.call(
            `/api/bot-groups/${group.groupId}/members/${member.id}/runtime-grants`,
            'POST',
            {
              expected_revision: snapshot.revision,
              expected_member_revision: member.revision,
              runtime_kind: 'node-durable',
              max_model_attempts: 4,
              tool_capabilities: ['create_approved_artifact'],
            },
          ),
        );
      }
    }
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${group.groupId}/messages`, 'POST', {
        content: 'Research the architecture and prepare an approved report.',
        mentions: [profiles.Researcher],
        dispatch: true,
      }),
    );
    await expect.poll(() => f.requests.length).toBe(1);
    await expect
      .poll(async () => (await f.snapshot(group.groupId)).handoffs?.[0].state)
      .toBe('running');
    const avatar = (page: Page, id = profiles.Researcher) =>
      page.locator(`.bot-avatar[data-bot-id="${id}"]`);
    let seed: string | null = null;
    let phone: Page | undefined;
    for (const [kind, width, height] of [
      ['desktop', 1440, 900],
      ['mobile', 390, 844],
      ['tablet', 900, 1000],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: kind === 'mobile',
        hasTouch: kind !== 'desktop',
        userAgent:
          kind === 'mobile'
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
            : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36',
      });
      contexts.push(context);
      expect(
        (
          await context.request.post(f.origin + '/api/auth/login', {
            data: f.credentials,
          })
        ).status(),
      ).toBe(200);
      if (kind === 'mobile')
        await context.addInitScript(() =>
          Object.defineProperty(navigator, 'standalone', { value: true }),
        );
      const page = await context.newPage();
      if (kind === 'mobile') phone = page;
      const base = f.origin + (kind === 'mobile' ? '/#' : '');
      for (const theme of ['light', 'dark']) {
        await page.goto(base + '/bots?view=team');
        await page.evaluate(
          (value) => localStorage.setItem('miniclaw-theme', value),
          theme,
        );
        await page.reload();
        const contact = page
          .locator('.bot-contact-row')
          .filter({ has: avatar(page) });
        await expect(contact.locator('.bot-avatar')).toHaveAttribute(
          'data-state',
          'working',
        );
        expect(
          await avatar(page).first().getAttribute('data-avatar-seed'),
        ).toBe(
          (seed ??= await avatar(page)
            .first()
            .getAttribute('data-avatar-seed')),
        );
        await expect(contact.locator('[data-generated-avatar]')).toBeVisible();
        if (kind !== 'tablet') {
          const navigation = page.getByRole('navigation', {
            name: kind === 'desktop' ? '桌面导航' : '主要导航',
            exact: true,
          });
          await expect(
            navigation
              .getByRole('link', { name: 'Miniclaw', exact: true })
              .locator('.bot-avatar'),
          ).toHaveAttribute('data-bot-id', group.profileId);
        }
        await expect(avatar(page, profiles.Developer).first()).toHaveAttribute(
          'data-state',
          'idle',
        );
        await expect(avatar(page, profiles.Developer).first()).toContainText(
          '🐙',
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${theme}-chief.png`),
          animations: 'disabled',
          scale: 'css',
        });
        await contact
          .getByRole('button', { name: 'Researcher', exact: true })
          .click();
        const detail = page.getByLabel('Dot 详情', { exact: true });
        await expect(detail.locator('.bot-avatar')).toHaveAttribute(
          'data-avatar-seed',
          seed!,
        );
        await page.keyboard.press('Escape');
        await page.goto(base + '/bot-groups/' + group.groupId);
        const task = page
          .locator('.group-task-activity')
          .filter({ has: avatar(page) });
        await expect(task.locator('.bot-avatar')).toHaveAttribute(
          'data-state',
          'working',
        );
        await expect(task.locator('.bot-avatar')).toHaveAttribute(
          'data-avatar-seed',
          seed!,
        );
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${theme}-group.png`),
          animations: 'disabled',
          scale: 'css',
        });
        await task.click();
        const contextView =
          kind === 'desktop'
            ? page.getByRole('complementary', { name: '当前工作' })
            : page.getByRole('dialog', { name: '当前工作', exact: true });
        await expect(contextView.locator('.bot-avatar')).toHaveAttribute(
          'data-avatar-seed',
          seed!,
        );
        await expect(contextView.locator('.bot-avatar')).toHaveAttribute(
          'data-state',
          'working',
        );
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${theme}-work-context.png`),
          animations: 'disabled',
          scale: 'css',
        });
        await closeGroupWork(page);
        if (kind === 'desktop')
          await page
            .getByRole('button', { name: '关闭上下文', exact: true })
            .click();
      }
    }
    expect(f.requests).toHaveLength(1);
    await phone!.context().setOffline(true);
    await expect(avatar(phone!).first()).not.toHaveAttribute(
      'data-state',
      'working',
    );
    await phone!.context().setOffline(false);
    await phone!.reload();
    await expect(
      phone!.locator('.group-task-activity .bot-avatar'),
    ).toHaveAttribute('data-state', 'working');
    expect(f.requests).toHaveLength(1);
    f.setModel(() => ({ text: 'The approved research report is ready.' }));
    f.release({
      tool: {
        name: 'create_approved_artifact',
        arguments: {
          content: 'Verified architecture report from the fixture provider.',
        },
      },
    });
    await expect
      .poll(async () => (await f.snapshot(group.groupId)).handoffs?.[0].state)
      .toBe('waiting_for_approval');
    await phone!.goto(f.origin + '/#/goals?view=attention');
    const attention = phone!
      .locator('.attention-item')
      .filter({ has: avatar(phone!) });
    await expect(attention.locator('.bot-avatar')).toHaveAttribute(
      'data-state',
      'attention',
    );
    await phone!.screenshot({
      path: test.info().outputPath('mobile-dark-attention.png'),
      animations: 'disabled',
      scale: 'css',
    });
    await phone!.goto(f.origin + '/#/bot-groups/' + group.groupId);
    await openGroupApproval(phone!);
    await phone!
      .getByRole('button', { name: '批准指定内容', exact: true })
      .click();
    await closeGroupWork(phone!);
    await expect
      .poll(async () => (await f.snapshot(group.groupId)).handoffs?.[0].state)
      .toBe('completed');
    await expect(
      phone!.locator('.group-task-activity .bot-avatar'),
    ).toHaveAttribute('data-state', 'completed');
    expect(f.requests).toHaveLength(2);
    // Actual authenticated upload must override the generated face on every product view.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDYQAAAAASUVORK5CYII=',
      'base64',
    );
    expect(
      (
        await phone!.request.post(
          f.origin + `/api/agent-profiles/${profiles.Researcher}/avatar`,
          {
            multipart: {
              avatar: {
                name: 'avatar.png',
                mimeType: 'image/png',
                buffer: png,
              },
            },
          },
        )
      ).status(),
    ).toBe(200);
    await phone!.goto(f.origin + '/#/bots?view=team');
    await expect
      .poll(() =>
        avatar(phone!)
          .first()
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    await phone!.goto(f.origin + '/#/bot-groups/' + group.groupId);
    await expect
      .poll(() =>
        phone!
          .locator('.group-task-activity .bot-avatar img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    expect(
      await phone!
        .locator('.group-task-activity .bot-avatar')
        .getAttribute('data-avatar-seed'),
    ).toBe(seed);
    expect(f.requests).toHaveLength(2);
  } finally {
    for (const context of contexts) await context.close();
    await f.dispose();
  }
});
