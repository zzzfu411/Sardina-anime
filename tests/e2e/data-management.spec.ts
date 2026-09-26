import { expect, test } from '@playwright/test';
import { card, episode } from '../helpers';
import { episodeKey, type HistoryEntry } from '../../packages/core/src/types';

test.beforeEach(async ({ page, request }) => {
  await request.get('/bootstrap?token=e2e-fixture-token');
  const library = await (await request.get('/api/v1/library')).json();
  for (const entry of library) await request.delete('/api/v1/library/' + entry.id);
  await request.delete('/api/v1/history');
  for (const [priority, id] of ['fixture', 'offline'].entries())
    await request.patch('/api/v1/sources/' + id, { data: { enabled: true, priority } });
  const settings = await (await request.get('/api/v1/settings')).json();
  await request.put('/api/v1/settings', { data: { ...settings, sourcePreferences: {} } });
  await page.goto('/bootstrap?token=e2e-fixture-token');
});

test('library retains filters on return, distinguishes filtered emptiness and applies selected statuses only', async ({
  page,
}) => {
  const fixtures = [
    { card, status: 'watching' },
    { card: { ...card, id: 'movie', title: '星空放映室 剧场版' }, status: 'planned' },
    { card: { ...card, id: 'old', title: '海风与旧时光' }, status: 'completed' },
  ];
  for (const fixture of fixtures)
    expect((await page.request.post('/api/v1/library', { data: fixture })).ok()).toBe(true);
  await page.goto('/library?status=watching&q=%E6%98%9F%E7%A9%BA&view=list&sort=title');
  await expect(page.locator('.management-library-entry')).toHaveCount(1);
  await page.locator('.management-library-copy').getByRole('link', { name: card.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: card.title, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('searchbox', { name: '库内搜索' })).toHaveValue('星空');
  await expect(page.getByRole('button', { name: '列表视图' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /^看完 1$/ }).click();
  await expect(page.getByRole('heading', { name: '当前条件下没有番剧' })).toBeVisible();
  await expect(page.getByText('资料库中还有 3 部番剧，可以更换关键词或筛选条件。')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await page.getByRole('button', { name: '批量调整状态' }).click();
  await page.getByRole('checkbox', { name: `选择 ${card.title}`, exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 星空放映室 剧场版', exact: true }).check();
  await page.getByRole('combobox', { name: '调整为' }).selectOption('paused');
  await page.getByRole('button', { name: '应用状态' }).click();
  await expect(page.getByText('已将 2 项设为「暂停」', { exact: true })).toBeVisible();
  const result = await (await page.request.get('/api/v1/library')).json();
  expect(result.find((entry: { card: { id: string } }) => entry.card.id === 'old').status).toBe('completed');
  expect(result.filter((entry: { status: string }) => entry.status === 'paused')).toHaveLength(2);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('library check reports failure and supports retrying that item', async ({ page }) => {
  await page.request.post('/api/v1/library', { data: { card, status: 'watching' } });
  await page.request.patch('/api/v1/sources/fixture', { data: { enabled: false, priority: 0 } });
  await page.goto('/library');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '上次检查' })).toContainText(
    '上次检查：成功 0 项，失败 1 项',
  );
  await expect(page.getByRole('button', { name: '重试此番剧' })).toBeVisible();
  await page.request.patch('/api/v1/sources/fixture', { data: { enabled: true, priority: 0 } });
  await page.getByRole('button', { name: '重试此番剧' }).click();
  await expect(page.getByRole('status').filter({ hasText: '上次检查' })).toContainText(
    '上次检查：成功 1 项，失败 0 项',
  );
  await expect(page.getByRole('button', { name: '重试此番剧' })).toHaveCount(0);
});

test('history searches beyond the former 1000 limit, paginates, explains lines and deletes one record only', async ({
  page,
}) => {
  const backup = await (await page.request.get('/api/v1/backup')).json();
  const history: HistoryEntry[] = Array.from({ length: 1105 }, (_, index) => {
    const item = episode(index + 1);
    return {
      key: episodeKey(item.locator),
      card,
      episode: item,
      position: 5,
      duration: 24,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    };
  });
  const earlyEpisode = {
    ...episode(1, 'archive'),
    locator: { ...episode(1, 'archive').locator, animeId: 'old' },
  };
  history.push({
    key: episodeKey(earlyEpisode.locator),
    card: { ...card, id: 'old', title: '很早的观看记录' },
    episode: earlyEpisode,
    position: 9,
    duration: 24,
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  expect((await page.request.post('/api/v1/backup/restore', { data: { ...backup, history } })).ok()).toBe(
    true,
  );
  await page.goto('/history');
  await expect(page.getByText(/已载入 50 \/ 1106 条记录/)).toBeVisible();
  await page.getByRole('button', { name: '加载更早记录' }).click();
  await expect(page.getByText(/已载入 100 \/ 1106 条记录/)).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索观看记录' }).fill('很早');
  await expect(page.getByRole('heading', { name: '很早的观看记录', exact: true })).toBeVisible();
  await page.getByText('查看分集与来源记录（已载入 1 条）', { exact: true }).click();
  await expect(page.getByText('测试来源 · 线路 archive', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '继续本集', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '从头重看', exact: true })).toHaveAttribute('href', /resume=0/);
  await page
    .getByRole('button', { name: '删除 很早的观看记录 第 1 话 测试来源 线路 archive 的记录', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '没有符合条件的观看记录' })).toBeVisible();
  const remaining = await (await page.request.get('/api/v1/history/page?limit=1')).json();
  expect(remaining.total).toBe(1105);
});

test('backup restoration previews contents, supports cancellation and can restore the pre-restore backup', async ({
  page,
}) => {
  const entry = await (
    await page.request.post('/api/v1/library', { data: { card, status: 'planned' } })
  ).json();
  const backup = await (await page.request.get('/api/v1/backup')).json();
  await page.request.patch('/api/v1/library/' + entry.id, { data: { status: 'completed' } });
  await page.goto('/settings');
  const file = {
    name: 'planned-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  };
  await page.getByLabel('选择备份文件').setInputFiles(file);
  const dialog = page.getByRole('dialog', { name: '确认恢复内容' });
  await expect(dialog).toContainText('planned-backup.json');
  await expect(dialog).toContainText('当前 1 部');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await (await page.request.get('/api/v1/library')).json())[0].status).toBe('completed');
  await page.getByLabel('选择备份文件').setInputFiles(file);
  await dialog.getByRole('button', { name: '确认替换并恢复' }).click();
  await expect(page.getByRole('button', { name: '恢复上一次资料' })).toBeVisible();
  expect((await (await page.request.get('/api/v1/library')).json())[0].status).toBe('planned');
  await page.getByRole('button', { name: '恢复上一次资料' }).click();
  await expect(dialog).toContainText('before-restore-');
  await dialog.getByRole('button', { name: '确认替换并恢复' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/library')).json())[0].status).toBe('completed');
});
