import fs from 'node:fs';
import { expect, test } from '@playwright/test';
const route = '/tests/e2e/bot-avatar-harness.html';

test('generated, emoji and uploaded Bot portraits breathe without moving their containers', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(route);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle('dark', dark),
        theme === 'dark',
      );
      for (const name of [
        'Chief',
        'Researcher',
        'Developer',
        'Emoji',
        'Uploaded',
        'Fallback',
      ]) {
        const avatar = page.getByRole('img', {
          name: name + ' · 常态',
          exact: true,
        });
        await avatar.scrollIntoViewIfNeeded();
        await expect(avatar).toHaveAttribute('data-visible', 'true');
        const motion = await avatar.evaluate((element) => {
          const visual =
            element.querySelector<HTMLElement>('.bot-avatar-visual')!;
          const animation = visual.getAnimations()[0];
          const bounds = element.getBoundingClientRect().toJSON();
          animation.pause();
          animation.currentTime = 0;
          const start = getComputedStyle(visual).transform;
          animation.currentTime = 3200;
          const end = getComputedStyle(visual).transform;
          return {
            start,
            end,
            bounds,
            after: element.getBoundingClientRect().toJSON(),
            duration: animation.effect?.getTiming().duration,
            name: getComputedStyle(visual).animationName,
          };
        });
        expect(motion.name).toBe('bot-breathe');
        expect(motion.duration).toBe(6400);
        expect(motion.end).not.toBe(motion.start);
        expect(motion.after).toEqual(motion.bounds);
      }
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.bot-avatar')
      .evaluateAll((elements) =>
        elements.every(
          (element) => element.getAnimations({ subtree: true }).length === 0,
        ),
      ),
  ).toBe(true);
});

test('stable generated identity and custom images in desktop/mobile/tablet, light/dark and reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let signature: unknown;
  for (const [kind, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
    ['tablet', 900, 1000],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark']) {
      await page.goto(route);
      await page.evaluate(
        (value) =>
          document.documentElement.classList.toggle('dark', value === 'dark'),
        theme,
      );
      const avatar = page.getByRole('img', {
        name: 'Researcher · 正在工作',
        exact: true,
      });
      await expect(avatar).toBeVisible();
      await expect(
        page
          .getByRole('img', { name: 'Fallback · 常态' })
          .locator('[data-generated-avatar]'),
      ).toBeVisible();
      await expect
        .poll(() =>
          page
            .getByRole('img', { name: 'Uploaded · 常态' })
            .locator('img')
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(40);
      expect(
        await avatar.evaluate(
          (element) => element.getAnimations({ subtree: true }).length,
        ),
      ).toBe(0);
      const identity = await avatar.evaluate((element) => ({
        seed: (element as HTMLElement).dataset.avatarSeed,
        shape: element.querySelector('path')?.getAttribute('d'),
      }));
      if (signature) expect(identity).toEqual(signature);
      else signature = identity;
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.screenshot({
        path: test.info().outputPath(kind + '-' + theme + '-avatars.png'),
        animations: 'disabled',
        scale: 'css',
      });
      await page.reload();
      expect(await avatar.getAttribute('data-avatar-seed')).toBe(
        (identity as { seed: string }).seed,
      );
    }
  }
});

test('motion pauses offscreen, waiting settles, emphasis is finite and click geometry never changes', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(route);
  const target = page.getByRole('button', {
    name: 'Inspect Researcher',
    exact: true,
  });
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const original = await target.boundingBox();
  const seed = await target
    .locator('.bot-avatar')
    .getAttribute('data-avatar-seed');
  for (const state of [
    'working',
    'thinking',
    'waiting',
    'attention',
    'completed',
    'error',
    'idle',
  ]) {
    await page.getByLabel('Preview state').selectOption(state);
    expect(await target.boundingBox()).toEqual(original);
    expect(
      await target.locator('.bot-avatar').getAttribute('data-avatar-seed'),
    ).toBe(seed);
  }
  await page.getByLabel('Preview state').selectOption('working');
  await expect
    .poll(() => target.locator('.bot-avatar').getAttribute('data-visible'))
    .toBe('true');
  expect(
    await target
      .locator('.bot-avatar-visual')
      .evaluate((element) => getComputedStyle(element).animationPlayState),
  ).toBe('running');
  const beforeTransform = await target
    .locator('.bot-avatar-visual')
    .evaluate((element) => getComputedStyle(element).transform);
  const frames = await page.evaluate(async () => {
    const times: number[] = [];
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        times.push(now);
        if (times.length === 61) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return {
      intervals: times.slice(1).map((time, index) => time - times[index]),
      avatars: document.querySelectorAll('.bot-avatar').length,
    };
  });
  fs.writeFileSync(
    testInfo.outputPath('emulated-frame-cadence.json'),
    JSON.stringify(frames, null, 2),
  );
  await testInfo.attach('emulated-frame-cadence.json', {
    body: JSON.stringify(frames),
    contentType: 'application/json',
  });
  expect(
    await target
      .locator('.bot-avatar-visual')
      .evaluate((element) => getComputedStyle(element).transform),
  ).not.toBe(beforeTransform);
  await page.getByLabel('Preview state').selectOption('waiting');
  expect(
    await target
      .locator('.bot-avatar-visual')
      .evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  await page.getByLabel('Preview state').selectOption('attention');
  expect(
    await target
      .locator('.bot-avatar-visual')
      .evaluate((element) =>
        element
          .getAnimations()
          .every((animation) => animation.effect?.getTiming().iterations === 1),
      ),
  ).toBe(true);
  const hidden = page.locator('[data-fixture="offscreen"] .bot-avatar');
  await expect(hidden).toHaveAttribute('data-visible', 'false');
  expect(
    await hidden
      .locator('.bot-avatar-visual')
      .evaluate((element) => getComputedStyle(element).animationPlayState),
  ).toBe('paused');
  await hidden.scrollIntoViewIfNeeded();
  await expect(hidden).toHaveAttribute('data-visible', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await hidden.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
});
