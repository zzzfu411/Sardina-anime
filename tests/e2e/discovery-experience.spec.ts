import { expect, test } from '@playwright/test';
import { card, episode } from '../helpers';

test.beforeEach(async ({ page, request }) => {
  await request.get('/bootstrap?token=e2e-fixture-token');
  const library = await (await request.get('/api/v1/library')).json();
  for (const entry of library) await request.delete('/api/v1/library/' + entry.id);
  await request.delete('/api/v1/history');
  const settings = await (await request.get('/api/v1/settings')).json();
  await request.put('/api/v1/settings', {
    data: { ...settings, sourcePreferences: {}, autoNext: false, volume: 0, playbackRate: 1 },
  });
  for (const [priority, id] of ['fixture', 'offline'].entries())
    await request.patch('/api/v1/sources/' + id, { data: { enabled: true, priority } });
  await page.goto('/bootstrap?token=e2e-fixture-token');
});

test('returning from a third search page preserves results, cursor and scroll without another search', async ({
  page,
}) => {
  const pages: number[] = [];
  await page.route('**/api/v1/search?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const number = JSON.parse(params.get('pages') || '{}').fixture ?? 1;
    pages.push(number);
    const items = Array.from({ length: 18 }, (_, index) => ({
      ...card,
      id: `page-${number}-${index}`,
      title: `分页测试 ${number}-${index}`,
      poster: undefined,
      imageUrl: undefined,
    }));
    if (number === 3) items.push({ ...card, poster: undefined, imageUrl: undefined });
    const events = [
      { type: 'source', sourceId: 'fixture', status: 'loading' },
      {
        type: 'result',
        sourceId: 'fixture',
        cached: false,
        page: { items, page: number, hasMore: number < 3, nextCursor: `cursor-${number + 1}` },
      },
      { type: 'done' },
    ];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });
  await page.goto('/search?q=' + encodeURIComponent('分页测试'));
  const more = page.getByRole('button', { name: '加载更多 测试来源 结果' });
  await more.click();
  await expect(page.locator('.search-grid .anime-tile')).toHaveCount(36);
  await more.click();
  await expect(page.locator('.search-grid .anime-tile')).toHaveCount(55);
  const target = page.getByRole('link', { name: '查看 星空放映室', exact: true });
  await target.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await target.click();
  await page.getByRole('link', { name: '返回搜索结果' }).click();
  await expect(page.locator('.search-grid .anime-tile')).toHaveCount(55);
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - scroll))
    .toBeLessThan(30);
  expect(pages).toEqual([1, 2, 3]);
  await target.click();
  await page.goBack();
  await expect(page.locator('.search-grid .anime-tile')).toHaveCount(55);
  await expect(target).toBeInViewport();
  expect(pages).toEqual([1, 2, 3]);
});

test('long episode lists locate the current episode and preserve fractional specials under filtering and sorting', async ({
  page,
}) => {
  await page.route('**/api/v1/sources/fixture/detail?**', async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.lines[0].episodes = Array.from({ length: 1205 }, (_, index) => episode(index + 1));
    detail.lines[0].episodes.push({ ...episode(12.5), kind: 'special', label: '第 12.5 话 幕间' });
    await route.fulfill({ response, json: detail });
  });
  await page.goto('/watch/fixture/one?line=mp4&episode=180&resume=0');
  const choices = page.locator('.episode-browser-grid');
  await expect(choices.getByRole('link')).toHaveCount(100);
  await expect(page.getByRole('combobox', { name: '剧集区间' })).toHaveValue('1');
  const current = choices.getByRole('link', { name: /^第 180 话 · 当前集/ });
  await expect(current).toBeInViewport();
  expect(
    await current.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const parent = node.parentElement!.getBoundingClientRect();
      return rect.top >= parent.top && rect.bottom <= parent.bottom;
    }),
  ).toBe(true);
  await page.getByRole('searchbox', { name: '按集数或标题找剧集' }).fill('12.5');
  await expect(choices.getByRole('link')).toHaveCount(1);
  await page.getByRole('combobox', { name: '剧集类型' }).selectOption('special');
  await page.getByRole('button', { name: '改为剧集倒序' }).click();
  await expect(page.getByRole('searchbox', { name: '按集数或标题找剧集' })).toHaveValue('12.5');
  await expect(choices.getByRole('link', { name: /第 12.5 话 幕间/ })).toBeVisible();
  await page.getByRole('button', { name: '定位当前集' }).click();
  await expect(current).toBeInViewport();
  await expect(choices.getByRole('link')).toHaveCount(100);
});

test('personal schedules separate source plans, actual additions and linked viewing progress', async ({
  page,
  request,
}) => {
  const added = await request.post('/api/v1/library', { data: { card, status: 'watching' } });
  await expect(added).toBeOK();
  const context = await (
    await request.get('/api/v1/history/entry?' + new URLSearchParams({ ...episode().locator }))
  ).json();
  const saved = await request.post('/api/v1/history', {
    data: {
      card,
      episode: episode(),
      position: 7,
      duration: 24,
      completed: false,
      capturedAt: new Date().toISOString(),
      version: context.version,
    },
  });
  await expect(saved).toBeOK();
  await page.route('**/api/v1/library', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data[0].updates = [
      { ...episode(2), key: 'second', sourceId: 'fixture', id: 'one', addedAt: new Date().toISOString() },
    ];
    await route.fulfill({ response, json: data });
  });
  await page.goto('/calendar?day=1&mine=1');
  await expect(page.getByRole('button', { name: '只看我的追番' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/来源排期，不代表已经更新/)).toBeVisible();
  const personal = page.locator('.schedule-personal-card');
  await expect(personal).toContainText('1 条新增提醒待查看');
  await expect(personal).toContainText('关联来源检测到：第 2 话');
  await expect(personal).toContainText('上次：第 1 话 · 0:07');
  await expect(personal.getByRole('link', { name: '继续观看' })).toBeVisible();
  await page.getByRole('tab', { name: /周二/ }).click();
  await expect(page).toHaveURL(/mine=1/);
  await expect(page.getByText('周二未列出你的追番')).toBeVisible();
  await page.getByRole('button', { name: '查看全部放送安排' }).click();
  await expect(page.getByText('周二暂未列出番剧')).toBeVisible();
});

test('catalog controls and cards fit 320, 390, 768 and 1440 widths with one narrow-screen sort control', async ({
  page,
}) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/catalog');
    const first = page.getByRole('link', { name: '查看 星空放映室', exact: true });
    await expect(first).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width <= 390) {
      await expect(page.getByRole('navigation', { name: '快捷排序' })).toBeHidden();
      const source = page.getByRole('combobox', { name: '当前索引来源' });
      await expect(source).toBeVisible();
      expect((await source.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await first.boundingBox())!.y).toBeLessThan(590);
      expect(
        (await page.getByRole('link', { name: '星空放映室', exact: true }).boundingBox())!.y,
      ).toBeLessThan(844);
    }
  }
});

test('module source defaults survive a new browser context with no local storage', async ({
  page,
  browser,
}) => {
  await page.goto('/search');
  await page.getByRole('combobox', { name: '搜索来源', exact: true }).selectOption('offline');
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/settings')).json()).sourcePreferences?.search)
    .toBe('offline');
  await page.goto('/');
  await page.getByRole('combobox', { name: '推荐来源', exact: true }).selectOption('offline');
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/settings')).json()).sourcePreferences?.home)
    .toBe('offline');
  const isolated = await browser.newContext();
  try {
    const reopened = await isolated.newPage();
    const recommendations: string[] = [];
    reopened.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/home') recommendations.push(url.searchParams.get('sourceId')!);
    });
    await reopened.goto(new URL('/bootstrap?token=e2e-fixture-token', page.url()).href);
    await expect(reopened.getByRole('combobox', { name: '推荐来源', exact: true })).toHaveValue('offline');
    await expect(reopened.getByRole('combobox', { name: '搜索来源', exact: true })).toHaveValue('offline');
    await expect.poll(() => recommendations.length).toBeGreaterThan(0);
    expect(recommendations.every((source) => source === 'offline')).toBe(true);
    await reopened
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '番剧索引', exact: true })
      .click();
    await expect(reopened.getByRole('button', { name: '测试来源', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  } finally {
    await isolated.close();
  }
});

test('restoring a backup cancels a delayed old source choice without replaying it in the restored profile', async ({
  page,
}) => {
  await page.goto('/search');
  const source = page.getByRole('combobox', { name: '搜索来源', exact: true });
  await expect(source).toHaveValue('fixture');
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/settings')).json()).sourcePreferences?.search)
    .toBe('fixture');
  const before = await (await page.request.get('/api/v1/settings')).json();
  const backup = await (await page.request.get('/api/v1/backup')).json();
  backup.settings.sourcePreferences = { ...backup.settings.sourcePreferences, search: 'fixture' };
  const choices: { generation: string; sourceId: string }[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/settings/source-preferences', async (route) => {
    const value = route.request().postDataJSON();
    if (value.module === 'search' && value.sourceId === 'offline') {
      choices.push(value);
      if (choices.length === 1) await held;
    }
    await route.continue();
  });
  try {
    await source.selectOption('offline');
    await expect.poll(() => choices.length).toBe(1);
    expect(choices[0].generation).toBe(before.generation);
    const restored = await page.request.post('/api/v1/backup/restore', { data: backup });
    await expect(restored).toBeOK();
    const after = await (await page.request.get('/api/v1/settings')).json();
    expect(after.generation).not.toBe(before.generation);
    release();
    await expect(page.getByText('资料已恢复或切换，旧的来源选择已取消。', { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await (await page.request.get('/api/v1/settings')).json()).sourcePreferences?.search)
      .toBe('fixture');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // Deliberate choices made after the reset may save again using the new identity.
    await source.selectOption('fixture');
    await source.selectOption('offline');
    await expect
      .poll(async () => (await (await page.request.get('/api/v1/settings')).json()).sourcePreferences?.search)
      .toBe('offline');
    expect(choices.map((choice) => choice.generation)).toEqual([before.generation, after.generation]);
  } finally {
    release();
  }
});
