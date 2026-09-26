import { expect, test, type Page } from '@playwright/test';
import { card, episode } from '../helpers';

test.beforeEach(async ({ page, request }) => {
  await request.get('/bootstrap?token=e2e-fixture-token');
  for (const entry of await (await request.get('/api/v1/library')).json())
    await request.delete('/api/v1/library/' + entry.id);
  await request.delete('/api/v1/history');
  const settings = await (await request.get('/api/v1/settings')).json();
  await request.put('/api/v1/settings', {
    data: { ...settings, autoNext: false, volume: 0, playbackRate: 1, sourcePreferences: {} },
  });
  for (const [priority, id] of ['fixture', 'offline'].entries())
    await request.patch('/api/v1/sources/' + id, { data: { enabled: true, priority } });
  await page.goto('/bootstrap?token=e2e-fixture-token');
});

async function ready(page: Page, number = 1) {
  const video = page.getByLabel(`星空放映室 第 ${number} 话`, { exact: true });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  return video;
}
async function pauseAt(page: Page, position: number, number = 1) {
  const video = await ready(page, number);
  await video.evaluate((element: HTMLVideoElement, at) => {
    element.currentTime = at;
    element.pause();
    element.dispatchEvent(new Event('pause'));
  }, position);
  return video;
}
async function seed(page: Page, number: number, position: number, offset: number, completed = false) {
  const item = episode(number);
  const context = await (
    await page.request.get('/api/v1/history/entry?' + new URLSearchParams({ ...item.locator }))
  ).json();
  const result = await page.request.post('/api/v1/history', {
    data: {
      card,
      episode: item,
      position,
      duration: 24,
      completed,
      capturedAt: new Date(Date.now() + offset).toISOString(),
      version: context.version,
    },
  });
  expect(result.ok()).toBe(true);
}

test('a next-episode resume parameter is consumed once and refresh resumes the saved position', async ({
  page,
}) => {
  await page.goto('/watch/fixture/one?line=mp4&episode=1&resume=0');
  await ready(page);
  await expect(page).not.toHaveURL(/resume=/);
  await page.getByRole('button', { name: '下一集', exact: true }).click();
  await pauseAt(page, 11, 2);
  await expect(page).not.toHaveURL(/resume=/);
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/history')).json()).find(
          (entry: any) => entry.episode.id === '2',
        )?.position,
    )
    .toBeGreaterThanOrEqual(11);
  await page.reload();
  const video = await ready(page, 2);
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThanOrEqual(10.5);
});

test('clearing history in another page stops the old player and stale cached progress cannot return', async ({
  page,
  context,
}) => {
  await page.goto('/watch/fixture/one?line=mp4&episode=1');
  await pauseAt(page, 9);
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/history')).json())[0]?.position)
    .toBeGreaterThanOrEqual(9);
  const second = await context.newPage();
  await second.goto('/history');
  second.once('dialog', (dialog) => dialog.accept());
  await second.getByRole('button', { name: '清空记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新读取进度', exact: true })).toBeVisible();
  expect(await (await page.request.get('/api/v1/history')).json()).toHaveLength(0);
  await page.getByRole('button', { name: '重新读取进度', exact: true }).click();
  const video = await ready(page);
  expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeLessThan(3);
  await second.close();
});

test('failed progress is visible, survives refresh and publishes only after acknowledgement', async ({
  page,
}) => {
  let failing = true;
  await page.route('**/api/v1/history', async (route) => {
    if (route.request().method() === 'POST' && failing)
      await route.fulfill({ status: 503, json: { code: 'TEST_OFFLINE', message: '模拟暂时离线' } });
    else await route.continue();
  });
  await page.goto('/watch/fixture/one?line=mp4&episode=1');
  await pauseAt(page, 8);
  await expect(page.getByText(/进度暂未保存，已保留在本机等待重试/)).toBeVisible();
  expect(await (await page.request.get('/api/v1/history')).json()).toHaveLength(0);
  await page.reload();
  const video = await ready(page);
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThanOrEqual(7.5);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await expect(page.getByRole('button', { name: '重试保存', exact: true })).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/history')).json())[0]?.position)
    .toBeGreaterThanOrEqual(8);
  await expect(page.getByRole('button', { name: '重试保存', exact: true })).toHaveCount(0);
});

test('home, detail and library choose the next episode after the most recently completed episode', async ({
  page,
}) => {
  await page.request.post('/api/v1/library', { data: { card, status: 'watching' } });
  await seed(page, 1, 9, -1000);
  await seed(page, 2, 24, 0, true);
  await page.goto('/anime/fixture/one');
  await expect(page.getByRole('link', { name: '观看下一话 · 第 12.5 话', exact: true })).toHaveAttribute(
    'href',
    /episode=12.5/,
  );
  await page.goto('/');
  await expect(page.locator('.cover-story')).toContainText('第 2 话 已看完');
  await page.locator('.cover-story').getByRole('link', { name: '继续观看', exact: true }).click();
  await ready(page, 12.5);
  await page.goto('/library');
  await page
    .getByRole('link', { name: /继续观看/ })
    .first()
    .click();
  await expect(page).toHaveURL(/episode=12.5/);
});

test('association is deferred, preview can cancel, confirmed sources can unlink and cancellation can undo', async ({
  page,
}) => {
  const alternate = { ...card, sourceId: 'offline', id: 'alternate' };
  await page.route('**/api/v1/search?**', async (route) => {
    const source = new URL(route.request().url()).searchParams.get('sourceId');
    if (source !== 'offline') return route.continue();
    await route.fulfill({
      contentType: 'text/event-stream',
      body:
        'data: ' +
        JSON.stringify({
          type: 'result',
          sourceId: source,
          page: { items: [alternate], page: 1, hasMore: false },
          cached: false,
        }) +
        '\n\ndata: {"type":"done"}\n\n',
    });
  });
  await page.goto('/anime/fixture/one');
  await page.getByRole('button', { name: '关联来源', exact: true }).click();
  expect(await (await page.request.get('/api/v1/library')).json()).toHaveLength(0);
  await page.getByRole('button', { name: '关联此来源', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('确认后才会新增收藏');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(await (await page.request.get('/api/v1/library')).json()).toHaveLength(0);
  await page.getByRole('button', { name: '关联此来源', exact: true }).click();
  await page.getByRole('checkbox', { name: '我已确认这是同一季度和版本' }).check();
  await page.getByRole('button', { name: '确认关联', exact: true }).click();
  await expect(page).toHaveURL('/anime/fixture/one');
  await page.getByRole('button', { name: '解除 offline 关联', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/library')).json())[0]?.refs.length)
    .toBe(1);
  await page.getByRole('button', { name: '已追番', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '已追番', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/v1/library')).json())[0].refs).toHaveLength(1);
});

test('disabled primary source keeps local recovery links in detail and watch pages', async ({ page }) => {
  const entry = await (
    await page.request.post('/api/v1/library', { data: { card, status: 'watching' } })
  ).json();
  await page.request.patch('/api/v1/library/' + entry.id, {
    data: { ref: { sourceId: 'offline', id: 'one' } },
  });
  await page.request.patch('/api/v1/sources/fixture', { data: { enabled: false, priority: 0 } });
  for (const path of ['/anime/fixture/one', '/watch/fixture/one?line=mp4&episode=1']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: card.title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '打开已关联来源 · offline', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '管理来源', exact: true })).toBeVisible();
  }
});

test('source recovery resumes the newest linked progress and respects completed episodes', async ({
  page,
}) => {
  const entry = await (
    await page.request.post('/api/v1/library', { data: { card, status: 'watching' } })
  ).json();
  await page.request.patch('/api/v1/library/' + entry.id, {
    data: { ref: { sourceId: 'offline', id: 'one' } },
  });
  const oldEpisode = episode(1, 'mp4', 'offline');
  const oldContext = await (
    await page.request.get('/api/v1/history/entry?' + new URLSearchParams({ ...oldEpisode.locator }))
  ).json();
  const saved = await page.request.post('/api/v1/history', {
    data: {
      card: { ...card, sourceId: 'offline' },
      episode: oldEpisode,
      position: 6,
      duration: 24,
      completed: false,
      capturedAt: new Date(Date.now() - 10_000).toISOString(),
      version: oldContext.version,
    },
  });
  expect(saved.ok()).toBe(true);
  await seed(page, 2, 9, 0);
  await page.request.patch('/api/v1/sources/offline', { data: { enabled: false, priority: 1 } });
  await page.goto('/anime/offline/one');
  await page.getByRole('link', { name: '打开已关联来源 · 测试来源', exact: true }).click();
  await expect(page.getByRole('link', { name: '继续观看 · 第 2 话 · 0:09', exact: true })).toBeVisible();

  await seed(page, 2, 24, 0, true);
  await page.goto('/watch/offline/one?line=mp4&episode=1');
  await page.getByRole('link', { name: '打开已关联来源 · 测试来源', exact: true }).click();
  await expect(page.getByRole('link', { name: '观看下一话 · 第 12.5 话', exact: true })).toBeVisible();
});

test('fullscreen failure recovery can switch lines while retaining position and mobile controls remain usable', async ({
  page,
}) => {
  await seed(page, 1, 9, 0);
  await page.route('**/api/v1/playbacks', async (route) => {
    if (route.request().postDataJSON()?.lineId === 'mp4')
      await route.fulfill({ status: 503, json: { code: 'TEST_MEDIA', message: '模拟线路失败' } });
    else await route.continue();
  });
  await page.goto('/watch/fixture/one?line=mp4&episode=1');
  await expect(page.getByText('这一线路暂时无法播放', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  const recovery = page.locator('.player-error');
  await expect(recovery.getByRole('button', { name: '查找其他来源', exact: true })).toBeInViewport();
  await recovery.getByRole('combobox', { name: '错误恢复线路' }).selectOption('hls');
  const video = await ready(page);
  await expect(page).toHaveURL(/line=hls/);
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThanOrEqual(8.5);
  if (await page.evaluate(() => Boolean(document.fullscreenElement)))
    await page.evaluate(() => document.exitFullscreen());
  await page.setViewportSize({ width: 320, height: 800 });
  const speed = await page.getByRole('combobox', { name: '播放速度' }).boundingBox();
  expect(speed!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.watch-footnote')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/ux-fixed-player-mobile.png', fullPage: true });
});
