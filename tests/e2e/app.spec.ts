import { expect, test } from '@playwright/test';
import { card } from '../helpers';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page, request }) => {
  await request.get('/bootstrap?token=e2e-fixture-token');
  const library = await (await request.get('/api/v1/library')).json();
  for (const entry of library) await request.delete('/api/v1/library/' + entry.id);
  await request.delete('/api/v1/history');
  await request.delete('/api/v1/search-history');
  await request.delete('/api/v1/sources/fixture/bangumi?itemId=one');
  const settings = await (await request.get('/api/v1/settings')).json();
  await request.put('/api/v1/settings', {
    data: { ...settings, autoNext: false, volume: 0, playbackRate: 1, sourcePreferences: {} },
  });
  for (const [priority, id] of ['fixture', 'offline'].entries())
    await request.patch('/api/v1/sources/' + id, { data: { enabled: true, priority } });
  await page.goto('/bootstrap?token=e2e-fixture-token');
});

test('browser sessions persist and missing authorization offers a working reconnect flow', async ({
  page,
}) => {
  const context = page.context();
  const cookie = (await context.cookies()).find((entry) => entry.name.startsWith('rev_'));
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  const settings = await (await context.request.get('/api/v1/settings')).json();
  const saved = await context.request.put('/api/v1/settings', { data: { ...settings, autoNext: true } });
  expect(saved.ok()).toBe(true);
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('浏览器需要重新连接');
  await expect(page.getByRole('alert')).toContainText('Start Web.command');
  await expect(page.getByText('等待重新连接', { exact: true })).toBeVisible();
  await expect(page.getByText('0 个来源已启用', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '搜索来源' })).toBeDisabled();

  // The launcher opens a new tab; the original tab can reconnect using the same browser cookie.
  const reopened = await context.newPage();
  await reopened.goto('/bootstrap?token=e2e-fixture-token');
  await page.getByRole('button', { name: '重新检查连接' }).click();
  await expect(page.getByRole('combobox', { name: '搜索来源' })).toHaveValue('fixture');
  await expect(page.getByText('2 个来源已启用', { exact: true })).toBeVisible();
  await expect(page.getByText('浏览器需要重新连接', { exact: true })).toHaveCount(0);
  expect((await (await context.request.get('/api/v1/settings')).json()).autoNext).toBe(true);
  await reopened.close();
});

test('detail ratings show provenance, preview a manual subject, persist it and recover after unlinking', async ({
  page,
}) => {
  await page.goto('/anime/fixture/one');
  const ratings = page.getByRole('region', { name: '番剧评分' });
  await expect(
    ratings.getByRole('link', { name: '查看 Bangumi 条目 星空放映室', exact: true }),
  ).toBeVisible();
  await expect(ratings.getByText('512 人评分 · 排名 #130')).toBeVisible();
  await expect(ratings.getByText('测试来源 站内', { exact: true })).toBeVisible();
  await ratings.getByText('更改 Bangumi 条目', { exact: true }).click();
  await ratings.getByRole('textbox', { name: 'Bangumi 片名或条目链接' }).fill('https://bgm.tv/subject/43');
  await ratings.getByRole('button', { name: '查找条目', exact: true }).click();
  await expect(ratings.getByRole('link', { name: '星空放映室 第二季', exact: true })).toBeVisible();
  await expect(
    ratings.getByRole('link', { name: '查看 Bangumi 条目 星空放映室', exact: true }),
  ).toBeVisible();
  await ratings.getByRole('button', { name: '选这部', exact: true }).click();
  await expect(ratings.locator('.rating-attribution')).toContainText('手动关联');
  await page.reload();
  await expect(
    ratings.getByRole('link', { name: '查看 Bangumi 条目 星空放映室 第二季', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await ratings.getByText('更改 Bangumi 条目', { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await ratings.getByRole('button', { name: '取消手动关联', exact: true }).click();
  await expect(
    ratings.getByRole('link', { name: '查看 Bangumi 条目 星空放映室', exact: true }),
  ).toBeVisible();
});

test('popular entry uses source-side heat/score sorting and preserves it through paging', async ({
  page,
}) => {
  const reads: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/catalog') reads.push(url);
  });
  await page.getByRole('link', { name: /热门与高分/ }).click();
  await expect(page.getByRole('heading', { name: '热门与高分', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看 星空放映室', exact: true })).toBeVisible();
  expect(reads[0].searchParams.get('sourceId')).toBe('fixture');
  expect(JSON.parse(reads[0].searchParams.get('filters')!)).toMatchObject({ sort: 'hits' });
  await page.getByRole('navigation', { name: '快捷排序' }).getByRole('button', { name: '来源评分' }).click();
  await expect(page.getByRole('combobox', { name: '目录排序' })).toHaveValue('score');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('link', { name: '查看 海风与旧时光', exact: true })).toBeVisible();
  expect(reads.every((url) => url.searchParams.get('sourceId') === 'fixture')).toBe(true);
  expect(JSON.parse(reads.at(-1)!.searchParams.get('filters')!)).toMatchObject({ sort: 'score' });
});

test('home loads the preferred recommendation source only and switches others on demand', async ({
  page,
}) => {
  // Finish the shared setup navigation before counting this visit's requests.
  await page.goto('/search');
  await page.getByRole('heading', { name: '最近搜索', exact: true }).waitFor();
  const reads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/home') reads.push(url.searchParams.get('sourceId')!);
  });
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: '推荐来源' })).toHaveValue('fixture');
  await expect(page.getByRole('link', { name: '查看番剧', exact: true })).toBeVisible();
  expect(reads).toEqual(['fixture']);
  await page.getByRole('combobox', { name: '推荐来源' }).selectOption('offline');
  await expect(page.getByText('暂时没有推荐内容')).toBeVisible();
  expect(reads).toEqual(['fixture', 'offline']);
  await page.getByRole('combobox', { name: '推荐来源' }).selectOption('fixture');
  await expect(page.getByRole('link', { name: '查看番剧', exact: true })).toBeVisible();
  expect(reads).toHaveLength(2);
  await page.getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '清空缓存', exact: true }).click();
  await expect(page.getByText('来源缓存已清空', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '发现', exact: true })
    .click();
  await expect(page.getByRole('link', { name: '查看番剧', exact: true })).toBeVisible();
  expect(reads).toEqual(['fixture', 'offline', 'fixture']);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('catalog filters the full source, paginates, changes view and returns from details with the same URL', async ({
  page,
}) => {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '番剧索引', exact: true })
    .click();
  await expect(page.getByText('3 个筛选结果')).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole('button', { name: '列表视图' }).click();
  const url = page.url();
  await page.getByRole('link', { name: '海风与旧时光', exact: true }).click();
  await expect(page.getByRole('heading', { name: '海风与旧时光' })).toBeVisible();
  await page.getByRole('link', { name: '返回番剧索引' }).click();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('button', { name: '列表视图' })).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('group', { name: '年份筛选' })
    .getByRole('button', { name: '2024', exact: true })
    .click();
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.getByText('1 个筛选结果')).toBeVisible();
  await expect(page.getByRole('link', { name: '星空放映室 剧场版', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '移除年份筛选' }).click();
  await expect(page.getByText('3 个筛选结果')).toBeVisible();
  await page.screenshot({ path: 'output/playwright/catalog-fixture.png', fullPage: true });
});

test('cursor-based catalog pages retain their continuation when reloaded and clear it on filter changes', async ({
  page,
}) => {
  await page.route('**/api/v1/sources', async (route) => {
    const response = await route.fetch();
    const sources = await response.json();
    sources[0].catalogPagination = 'cursor';
    await route.fulfill({ response, json: sources });
  });
  await page.route('**/api/v1/catalog?**', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (data.hasMore) data.nextCursor = '33760';
    await route.fulfill({ response, json: data });
  });
  await page.goto('/catalog');
  await expect(page.getByText('3 个筛选结果')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: '跳转页码' })).toHaveCount(0);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page).toHaveURL(/cursor=33760/);
  await page.reload();
  await expect(page.getByRole('link', { name: '海风与旧时光', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page
    .getByRole('group', { name: '年份筛选' })
    .getByRole('button', { name: '2024', exact: true })
    .click();
  await expect(page).not.toHaveURL(/cursor=|trail=|page=2/);
  await expect(page.getByText('1 个筛选结果')).toBeVisible();
});

test('schedule switches real weekday groups and connects to details without implying availability', async ({
  page,
}) => {
  await page.goto('/calendar?day=1');
  await expect(page.getByRole('tab', { name: /周一/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/实际更新与可播放集数以详情页为准/)).toBeVisible();
  await page.getByRole('link', { name: '星空放映室', exact: true }).click();
  await page.getByRole('link', { name: '返回每周放送' }).click();
  await expect(page).toHaveURL(/day=1/);
  await page.getByRole('tab', { name: /周二/ }).click();
  await expect(page.getByText('周二暂未列出番剧')).toBeVisible();
});

test('recent searches survive reload, can be reused and deleted, and search filters distinguish unknown metadata', async ({
  page,
}) => {
  await page.goto('/search?q=' + encodeURIComponent('星空'));
  await expect(page.getByRole('link', { name: '星空放映室', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '搜索结果类型' }).selectOption('movie');
  await expect(page.getByText('当前筛选下没有结果')).toBeVisible();
  await page.getByRole('button', { name: '清除结果筛选' }).click();
  await expect(page.getByRole('link', { name: '星空放映室', exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '搜索', exact: true })
    .click();
  await page.reload();
  await page.getByRole('link', { name: '星空', exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '搜索', exact: true })
    .click();
  await page.getByRole('button', { name: '删除搜索 星空', exact: true }).click();
  await expect(page.getByRole('link', { name: '星空', exact: true })).toHaveCount(0);
});

test('discovery navigation and filters fit a phone-sized window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/catalog', '/calendar?day=1', '/search']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link', { name: '番剧索引', exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: 'output/playwright/discovery-mobile.png', fullPage: true });
});

test('search → favorite → play, seek, speed, resume, next episode and hls.js fallback', async ({ page }) => {
  // Chrome should use hls.js even when it advertises native HLS support.
  // Safari keeps the native path, checked separately with decoded video frames.
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type: string) {
      return /mpegurl/i.test(type) ? 'probably' : original.call(this, type);
    };
  });
  await page.getByRole('textbox', { name: '搜索番剧' }).fill('星空');
  await page.getByRole('button', { name: '开始搜索' }).click();
  await expect(page.getByRole('heading', { name: '“星空”', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '星空放映室', exact: true })).toBeVisible();
  await page
    .getByRole('link', { name: /星空放映室/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: '星空放映室' })).toBeVisible();
  await page.getByRole('button', { name: '追番', exact: true }).click();
  await expect(page.getByRole('button', { name: '已追番', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /^第 1 话 ·/ }).click();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(480);
  await page.getByRole('combobox', { name: '播放速度' }).selectOption('1.5');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5);
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 12;
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(12.2);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  const saved = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect
    .poll(async () => (await (await page.request.get('/api/v1/history')).json())[0]?.position)
    .toBeGreaterThan(12);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '观看记录' }).click();
  await page.getByRole('link', { name: '继续观看', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(saved - 1);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(480);
  await page.getByRole('combobox', { name: '播放线路' }).selectOption('hls');
  await expect(page).toHaveURL(/line=hls/);
  await expect(video).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(saved - 1);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames))
    .toBeGreaterThan(5);
  await page.getByRole('button', { name: '下一集', exact: true }).click();
  await expect(page).toHaveURL(/episode=2/);
  await expect(video).toHaveAttribute('aria-label', '星空放映室 第 2 话');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(7);
  await page.screenshot({ path: 'output/playwright/player-fixture.png', fullPage: true });
});

test('player keyboard taps seek exactly five seconds with focused native controls and clamp at either end', async ({
  page,
}) => {
  await page.goto('/watch/fixture/one?line=mp4&episode=1&resume=0');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  await video.evaluate((v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = 10;
  });
  await video.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(15);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(10);
  await page.keyboard.down('ArrowLeft');
  await page.keyboard.down('ArrowLeft'); // Browser auto-repeat is still one press.
  await page.keyboard.up('ArrowLeft');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(5);

  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 2;
  });
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
  const end = await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = v.duration - 2;
    return v.duration;
  });
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(end);
});

test('player keyboard hold uses 2x in fullscreen without an overlay, seeking or overwriting the chosen speed', async ({
  page,
}) => {
  await page.goto('/watch/fixture/one?line=mp4&episode=1&resume=0');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  await page.getByRole('combobox', { name: '播放速度' }).selectOption('1.5');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5);
  await video.focus();
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await video.focus();
  const start = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.keyboard.down('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2);
  await expect(page.getByText('2× 倍速播放', { exact: true })).toHaveCount(0);
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  expect((await video.evaluate((v: HTMLVideoElement) => v.currentTime)) - start).toBeLessThan(4);
  await expect(page.getByRole('combobox', { name: '播放速度' })).toHaveValue('1.5');

  // A volume update must not replace the temporary rate or persist it as the preferred speed.
  await video.evaluate((v: HTMLVideoElement) => {
    v.volume = 0.2;
  });
  await expect.poll(async () => (await (await page.request.get('/api/v1/settings')).json()).volume).toBe(0.2);
  expect((await (await page.request.get('/api/v1/settings')).json()).playbackRate).toBe(1.5);
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2);
  await page.screenshot({ path: 'output/playwright/player-keyboard-clean.png', fullPage: true });
  const beforeRelease = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.keyboard.up('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5);
  expect((await video.evaluate((v: HTMLVideoElement) => v.currentTime)) - beforeRelease).toBeLessThan(2);
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});

test('player keyboard hold restores on interruption and leaves text editing and the next episode alone', async ({
  page,
}) => {
  await page.goto('/watch/fixture/one?line=hls&episode=1&resume=0');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  await page.getByRole('combobox', { name: '播放速度' }).selectOption('1.25');
  await video.focus();
  await page.keyboard.down('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2);
  // Simulate losing the OS key-up event when switching away from the browser.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.25);
  await page.keyboard.up('ArrowRight');

  await page.keyboard.down('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2);
  await video.evaluate((v: HTMLVideoElement) => v.pause());
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.25);
  await page.keyboard.up('ArrowRight');
  const pausedAt = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  const search = page.getByRole('textbox', { name: '搜索番剧', exact: true });
  await search.fill('正在输入');
  await page.keyboard.press('ArrowRight', { delay: 450 });
  await page.keyboard.press('ArrowLeft');
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(pausedAt);
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.25);

  await video.evaluate((v: HTMLVideoElement) => v.play());
  await video.focus();
  await page.keyboard.down('ArrowRight');
  await search.focus(); // Focus changes must cancel even a hold that has not started boosting yet.
  await page.waitForTimeout(450);
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.25);
  await page.keyboard.up('ArrowRight');

  await video.focus();
  await page.keyboard.down('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2);
  await page.getByRole('button', { name: '下一集', exact: true }).click();
  await page.keyboard.up('ArrowRight');
  await expect(video).toHaveAttribute('aria-label', '星空放映室 第 2 话');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  expect(await video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.25);
  expect((await (await page.request.get('/api/v1/settings')).json()).playbackRate).toBe(1.25);
});

test('searches only the chosen source, shows its errors, and retains the selection for a new query', async ({
  page,
}) => {
  const requested: { source: string | null; keyword: string | null }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/search')
      requested.push({ source: url.searchParams.get('sourceId'), keyword: url.searchParams.get('q') });
  });
  await page.goto('/search');
  await page.getByRole('combobox', { name: '搜索来源', exact: true }).selectOption('offline');
  expect(requested).toEqual([]);
  await page.getByRole('textbox', { name: '搜索番剧', exact: true }).fill('first');
  await page.getByRole('button', { name: '开始搜索', exact: true }).click();
  await expect(page.getByText('测试来源暂时受限')).toBeVisible();
  await expect(page.getByRole('link', { name: '星空放映室', exact: true })).toHaveCount(0);
  expect(requested).toEqual([{ source: 'offline', keyword: 'first' }]);
  await page
    .getByRole('region', { name: '选择搜索来源' })
    .getByRole('button', { name: '测试来源', exact: true })
    .click();
  await expect(page.getByRole('link', { name: '星空放映室', exact: true })).toBeVisible();
  await expect(page.getByText('测试来源暂时受限')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索番剧' }).fill('second');
  await page.getByRole('button', { name: '开始搜索' }).click();
  await expect(page).toHaveURL(/q=second/);
  await expect(page.getByRole('heading', { name: '“second”', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /星空放映室/ }).first()).toBeVisible();
  await expect
    .poll(() => requested)
    .toEqual([
      { source: 'offline', keyword: 'first' },
      { source: 'fixture', keyword: 'first' },
      { source: 'fixture', keyword: 'second' },
    ]);
  await page.screenshot({ path: 'output/playwright/search-fixture.png', fullPage: true });
});

test('layout remains usable at a narrow window size', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 800 });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/playwright/settings-860.png', fullPage: true });
});

test('automatically advances after ended and supports fullscreen', async ({ page }) => {
  const settings = await (await page.request.get('/api/v1/settings')).json();
  await page.request.put('/api/v1/settings', {
    data: { ...settings, autoNext: true, volume: 0, playbackRate: 1 },
  });
  await page.goto('/watch/fixture/one?line=mp4&episode=1&resume=0');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = v.duration - 0.5;
  });
  await expect(page).toHaveURL(/episode=2/);
  await expect(video).toHaveAttribute('aria-label', '星空放映室 第 2 话');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
});

test('refreshes a failed media request once and recovers playback', async ({ page }) => {
  let failed = false,
    refreshes = 0;
  await page.route('**/api/v1/media/**', async (route) => {
    if (!failed) {
      failed = true;
      await route.abort('failed');
    } else await route.continue();
  });
  page.on('request', (request) => {
    if (/\/playbacks\/[^/]+\/refresh$/.test(request.url())) refreshes++;
  });
  await page.goto('/watch/fixture/one?line=mp4&episode=1&resume=0');
  await expect
    .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(1);
  expect(refreshes).toBe(1);
});

test('exports and restores a backup and shares persisted data with a second window', async ({
  page,
  context,
}) => {
  const entry = await (
    await page.request.post('/api/v1/library', { data: { card, status: 'planned' } })
  ).json();
  await page.goto('/settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '导出备份' }).click();
  const download = await downloadPromise;
  const bytes = await readFile((await download.path())!);
  const backup = JSON.parse(bytes.toString());
  expect(backup.version).toBe(1);
  expect(backup.library).toHaveLength(1);
  await page.request.patch('/api/v1/library/' + entry.id, { data: { status: 'completed' } });
  await page
    .getByLabel('选择备份文件')
    .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await page.getByRole('dialog').getByRole('button', { name: '确认替换并恢复', exact: true }).click();
  await expect(page.getByText('备份已恢复，原资料已自动备份', { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/library');
  await expect(second.getByRole('heading', { name: '我的番剧', exact: true })).toBeVisible();
  expect((await (await second.request.get('/api/v1/library')).json())[0].status).toBe('planned');
  await second.close();
});
