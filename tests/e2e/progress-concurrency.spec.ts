import { expect, test, type Page } from '@playwright/test';
import { card, episode } from '../helpers';
import type { HistoryEntry } from '../../packages/core/src/types';

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function history(page: Page): Promise<HistoryEntry[]> {
  return (await page.request.get('/api/v1/history')).json();
}

async function pauseAt(page: Page, number: number, position: number) {
  const video = page.getByLabel(`星空放映室 第 ${number} 话`, { exact: true });
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate((element: HTMLVideoElement, at) => {
    element.currentTime = at;
    element.pause();
    element.dispatchEvent(new Event('pause'));
  }, position);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await expect
    .poll(async () => (await history(page)).find((entry) => entry.episode.id === String(number))?.position)
    .toBeGreaterThanOrEqual(position);
  await expect(page.locator('.progress-save-status')).toContainText('进度自动保存');
  return video;
}

async function seedFirstEpisode(page: Page) {
  const item = episode(1);
  const context = await (
    await page.request.get('/api/v1/history/entry?' + new URLSearchParams({ ...item.locator }))
  ).json();
  const result = await page.request.post('/api/v1/history', {
    data: {
      card,
      episode: item,
      position: 9,
      duration: 24,
      completed: false,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      version: context.version,
    },
  });
  expect(result.ok()).toBe(true);
}

async function openDetailReady(page: Page) {
  const contextRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname === '/api/v1/history/entry' &&
      url.searchParams.get('lineId') === 'mp4' &&
      url.searchParams.get('episodeId') === '1'
    );
  });
  await page.goto('/anime/fixture/one');
  const response = await contextRead;
  expect(response.ok()).toBe(true);
  await response.finished();
  // The completion action freezes the context rendered before the user clicks it.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(page.getByRole('button', { name: '标记为已看完', exact: true })).toBeVisible();
}

async function clearInOtherWindow(page: Page) {
  await page.goto('/history');
  await expect(page.getByRole('button', { name: '清空记录', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清空记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有观看记录', exact: true })).toBeVisible();
  expect(await history(page)).toHaveLength(0);
}

test('an unchanged paused window preserves another window’s completion and newer episode after a sampling interval', async ({
  page,
  context,
}) => {
  await page.clock.install();
  await page.goto('/watch/fixture/one?line=mp4&episode=1');
  const oldVideo = await pauseAt(page, 1, 9);
  const second = await context.newPage();
  try {
    await openDetailReady(second);
    await second.getByRole('button', { name: '标记为已看完', exact: true }).click();
    await expect
      .poll(async () => (await history(second)).find((entry) => entry.episode.id === '1')?.completed)
      .toBe(true);
    const completedAt = (await history(second)).find((entry) => entry.episode.id === '1')!.capturedAt;

    await second.goto('/watch/fixture/one?line=mp4&episode=2&resume=0');
    await pauseAt(second, 2, 12);
    await expect.poll(async () => (await history(second))[0]?.episode.id).toBe('2');
    const newestAt = (await history(second))[0].capturedAt;

    // Advance the first window's real application timers past the five-second sampler.
    await page.clock.runFor(6_000);
    expect(await oldVideo.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    const saved = await history(page);
    expect(saved[0].episode.id).toBe('2');
    expect(saved[0].capturedAt).toBe(newestAt);
    expect(saved.find((entry) => entry.episode.id === '1')).toMatchObject({
      completed: true,
      capturedAt: completedAt,
    });

    await second
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '观看记录', exact: true })
      .click();
    await expect(second.locator('.management-history-heading')).toContainText('第 2 话');
  } finally {
    await second.close();
  }
});

for (const phase of ['before the manual GET is processed', 'after the manual POST is committed'] as const) {
  test(`deleting history ${phase} prevents a late completion operation from restoring records or cached progress`, async ({
    page,
    context,
  }) => {
    await page.clock.install();
    await seedFirstEpisode(page);
    await openDetailReady(page);
    const intercepted = deferred();
    const release = deferred();
    let armed = true;
    let second: Page | undefined;
    const getPhase = phase.startsWith('before');
    const pattern = getPhase ? '**/api/v1/history/entry?**' : '**/api/v1/history';
    await page.route(pattern, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const matches = getPhase
        ? request.method() === 'GET' &&
          url.searchParams.get('lineId') === 'mp4' &&
          url.searchParams.get('episodeId') === '1'
        : request.method() === 'POST' && request.postDataJSON()?.completed === true;
      if (!armed || !matches) return route.continue();
      armed = false;
      // For the POST case SQLite has accepted the save, but its acknowledgement is still in flight.
      const response = getPhase ? undefined : await route.fetch();
      if (response) expect(response.ok()).toBe(true);
      intercepted.resolve();
      await release.promise;
      if (response) await route.fulfill({ response });
      else await route.continue();
    });
    try {
      await page.getByRole('button', { name: '标记为已看完', exact: true }).click();
      await intercepted.promise;
      second = await context.newPage();
      await clearInOtherWindow(second);
      release.resolve();

      await expect(page.getByRole('alert').filter({ hasText: /观看记录已/ })).toBeVisible();
      await expect(page.getByRole('link', { name: '开始观看 · 第 1 话', exact: true })).toBeVisible();
      await page.clock.runFor(6_000);
      expect(await history(page)).toHaveLength(0);
      // SPA navigation retains the query client, exposing stale cache resurrection as well as DB writes.
      await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: '观看记录', exact: true })
        .click();
      await expect(page.getByRole('heading', { name: '还没有观看记录', exact: true })).toBeVisible();
      expect(await history(page)).toHaveLength(0);
    } finally {
      release.resolve();
      await page.unroute(pattern);
      await second?.close();
    }
  });
}
