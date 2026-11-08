import { expect, test, type Page } from '@playwright/test';

type Goal = {
  id: string;
  workspace_jid: string;
  objective: string;
  completion_criteria: string[];
  next_action: string;
  status: string;
  budget_max_runs: number;
  budget_used_runs: number;
  revision: number;
  updated_at: string;
};
const sample: Goal = {
  id: 'goal-research',
  workspace_jid: 'web:project',
  objective: '跟踪项目健康',
  completion_criteria: ['提交研究报告'],
  next_action: '检查最新变更',
  status: 'running',
  budget_max_runs: 3,
  budget_used_runs: 1,
  revision: 2,
  updated_at: '2026-10-16T00:00:00Z',
};
const harness = '/tests/e2e/personal-goals-harness.html';
async function goalRoutes(page: Page, handler: Parameters<Page['route']>[1]) {
  await page.route('**/api/goals**', handler);
  // Ancillary Team reads are independent of the Goal under test.
  await page.route('**/api/goals/team-options', (route) =>
    route.fulfill({ json: { teams: [] } }),
  );
}
async function tasks(page: Page) {
  await page.route('**/api/team-overview', (route) =>
    route.fulfill({
      json: { goals: [], groups: [], attention: [], activity: {} },
    }),
  );
  // UI-only Goal fixtures must not forward unrelated availability reads to a
  // developer backend. Actual Scheduler/Cloud acceptance uses private servers.
  for (const endpoint of ['github-goals', 'personal-memory'])
    await page.route(`**/api/${endpoint}/availability*`, (route) =>
      route.fulfill({ json: { enabled: false } }),
    );
  await page.route('**/api/device-nodes/availability', (route) =>
    route.fulfill({ json: { enabled: false } }),
  );
  await page.route('**/api/device-nodes', (route) =>
    route.fulfill({ json: { devices: [] } }),
  );
  await page.route('**/api/tasks', (route) =>
    route.fulfill({ json: { tasks: [] } }),
  );
}

test('mobile Goal creation retries an unacknowledged submission with the same key (mock API)', async ({
  page,
}) => {
  await tasks(page);
  const goals: Goal[] = [];
  const keys: string[] = [];
  await goalRoutes(page, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/goals' && request.method() === 'POST') {
      keys.push(request.headers()['idempotency-key']);
      if (!goals.length)
        goals.push({
          ...sample,
          ...request.postDataJSON(),
          id: 'created-goal',
          status: 'pending',
          budget_used_runs: 0,
          revision: 1,
        });
      if (keys.length === 1) await route.abort('failed');
      else await route.fulfill({ status: 201, json: { goal: goals[0] } });
    } else if (pathname === '/api/goals')
      await route.fulfill({ json: { goals } });
    else
      await route.fulfill({
        json: { goal: goals[0], tasks: [], executions: [] },
      });
  });
  await page.goto(harness);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '新建目标', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: '新建', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByLabel('目标', { exact: true }).fill('研究长期项目');
  await page.getByLabel('完成条件（每行一条）').fill('交付报告');
  await page.getByRole('button', { name: '创建委托', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('提交结果尚未确认');
  await expect(page.getByLabel('目标', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '核对原提交', exact: true }).click();
  await expect(page.getByLabel('目标', { exact: true })).toHaveValue(
    '研究长期项目',
  );
  await expect(page.getByLabel('目标', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重试原提交', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '研究长期项目', exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(goals).toHaveLength(1);
  await page.screenshot({
    path: test.info().outputPath('goal-mobile.png'),
    fullPage: true,
  });
});

test('failed stopping keeps the Goal paused and shows the server error (mock API)', async ({
  page,
}) => {
  await tasks(page);
  let goal = { ...sample };
  await goalRoutes(page, async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      goal = { ...goal, status: 'paused', revision: 3 };
      await route.fulfill({
        status: 409,
        json: {
          error: 'Goal paused; stopping current runs needs retry',
          code: 'GOAL_STOP_PENDING',
          goal,
          pending_run_ids: ['run-1'],
        },
      });
    } else if (new URL(request.url()).pathname === '/api/goals')
      await route.fulfill({ json: { goals: [goal] } });
    else await route.fulfill({ json: { goal, tasks: [], executions: [] } });
  });
  await page.goto(harness);
  await page.getByRole('button', { name: /跟踪项目健康/ }).click();
  await page.getByRole('button', { name: '取消委托', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '取消委托', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'stopping current runs needs retry',
  );
  await expect(
    page.getByRole('region', { name: '委托详情' }).getByRole('status'),
  ).toContainText('已暂停');
  expect(goal.status).toBe('paused');
});

test('a stale revision reloads server state before another explicit change (mock API)', async ({
  page,
}) => {
  await tasks(page);
  let goal = { ...sample };
  const revisions: number[] = [];
  await goalRoutes(page, async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      revisions.push(request.postDataJSON().expected_revision);
      if (revisions.length === 1) {
        goal = { ...goal, revision: 4 };
        await route.fulfill({
          status: 409,
          json: {
            error: 'Goal changed; reload and retry',
            code: 'GOAL_REVISION_CONFLICT',
          },
        });
      } else {
        goal = { ...goal, status: 'paused', revision: 5 };
        await route.fulfill({ json: { goal } });
      }
    } else if (new URL(request.url()).pathname === '/api/goals')
      await route.fulfill({ json: { goals: [goal] } });
    else await route.fulfill({ json: { goal, tasks: [], executions: [] } });
  });
  await page.goto(harness);
  await page.getByRole('button', { name: /跟踪项目健康/ }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('reload and retry');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '委托详情' }).getByRole('status'),
  ).toContainText('已暂停');
  expect(revisions).toEqual([2, 4]);
});

test('confirmed Workspace denial clears the previous Goal and its touch detail (mock API)', async ({
  page,
}) => {
  await tasks(page);
  let revoked = false;
  await goalRoutes(page, async (route) => {
    if (revoked)
      return route.fulfill({
        status: 403,
        json: { error: 'Workspace access revoked' },
      });
    const list = new URL(route.request().url()).pathname === '/api/goals';
    await route.fulfill({
      json: list
        ? { goals: [sample] }
        : { goal: sample, tasks: [], executions: [] },
    });
  });
  await page.route('**/api/team-overview', (route) =>
    route.fulfill({
      json: { goals: [sample], groups: [], attention: [], activity: {} },
    }),
  );
  await page.goto(harness);
  await page.getByRole('button', { name: /跟踪项目健康/ }).click();
  await expect(
    page.getByRole('dialog', { name: '目标进展', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: sample.objective, exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('link', { name: new RegExp(sample.objective) }),
  ).toBeVisible();
  revoked = true;
  await page.getByRole('button', { name: '刷新委托', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Workspace access revoked',
  );
  await expect(
    page.getByRole('heading', { name: sample.objective, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(sample.objective, { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: /跟踪项目健康/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('region', { name: '委托详情', exact: true }),
  ).toHaveCount(0);
});

test('opening another Goal never exposes controls for the previous detail during a delayed read (mock API)', async ({
  page,
}) => {
  await tasks(page);
  const other = { ...sample, id: 'second-goal', objective: '研究第二个项目' };
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mutations: string[] = [];
  await goalRoutes(page, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'PATCH') {
      mutations.push(pathname);
      return route.fulfill({ json: { goal: { ...other, status: 'paused' } } });
    }
    if (pathname.endsWith('/second-goal')) {
      await gate;
      return route.fulfill({
        json: { goal: other, tasks: [], executions: [] },
      });
    }
    await route.fulfill({
      json:
        pathname === '/api/goals'
          ? { goals: [sample, other] }
          : { goal: sample, tasks: [], executions: [] },
    });
  });
  try {
    await page.goto(harness);
    const first = page.getByRole('button', { name: /跟踪项目健康/ });
    await first.click();
    await expect(
      page.getByRole('heading', { name: sample.objective, exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(first).toBeFocused();
    await page.getByRole('button', { name: /研究第二个项目/ }).click();
    await expect(
      page.getByRole('heading', { name: sample.objective, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '暂停', exact: true }),
    ).toHaveCount(0);
    release!();
    await expect(
      page.getByRole('heading', { name: other.objective, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect.poll(() => mutations).toEqual(['/api/goals/second-goal']);
  } finally {
    release!();
  }
});
