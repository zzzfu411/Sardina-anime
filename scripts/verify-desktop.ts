import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { APP_VERSION } from '../packages/core/src/types';

const windows = process.platform === 'win32';
const executablePath = resolve(
  process.env.REVANIME_TEST_APP ??
    (windows
      ? 'release/win-unpacked/Sardina anime.exe'
      : 'release/mac-arm64/Sardina anime.app/Contents/MacOS/Sardina anime'),
);
await mkdir('.cache', { recursive: true });
const profile = await mkdtemp(resolve(`.cache/desktop-validation-${APP_VERSION}-${process.platform}-`));
// On Windows, environment names are case-insensitive. Remove every PATH spelling.
const desktopEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[0].toLowerCase() !== 'path' && entry[1] !== undefined,
  ),
);
desktopEnv.PATH = windows
  ? resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32')
  : '/usr/bin:/bin:/usr/sbin:/sbin';
desktopEnv.REVANIME_DATA_DIR = profile;
const reportPath =
  process.env.REVANIME_TEST_REPORT ??
  `docs/validation/desktop-${APP_VERSION}-${process.platform}-${process.arch}.json`;
const appArgs = [`--user-data-dir=${profile}/chromium`];
await mkdir(profile, { recursive: true });
await mkdir('output/playwright', { recursive: true });
const report: Record<string, unknown> = {
  version: APP_VERSION,
  checkedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  systemNodeOnPath: false,
  testedApp: executablePath,
  isolatedProfile: profile,
};
const app = await electron.launch({
  executablePath,
  args: appArgs,
  env: desktopEnv,
  timeout: 45_000,
});
try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('heading', { name: '发现', exact: true }).waitFor({ timeout: 30_000 });
  report.title = await page.title();
  report.preferences = await app.evaluate(({ BrowserWindow }) => {
    // Test-only inspection of Electron's runtime preferences; this diagnostic method is not in its public typings.
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
      getLastWebPreferences(): { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean };
    };
    const prefs = contents.getLastWebPreferences();
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    };
  });
  report.engine = await page.evaluate(async () => {
    const r = await fetch('/api/v1/health');
    return r.json();
  });
  assert.deepEqual(report.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.equal((report.engine as { version: string }).version, APP_VERSION);
  const sources = await page.evaluate(async () => {
    const response = await fetch('/api/v1/sources');
    return (await response.json()) as { id: string; name: string }[];
  });
  report.sources = sources.map(({ id, name }) => ({ id, name }));
  assert.equal(sources[0].id, 'girigiri');
  const homeSource = page.getByRole('combobox', { name: '推荐来源' });
  await homeSource.waitFor();
  assert.equal(await homeSource.inputValue(), 'girigiri');
  report.preferredSource = 'girigiri';
  for (const id of ['anich', 'aki', 'girigiri', 'erkuang', 'gugu', 'ledou', 'xifan'])
    assert.ok(
      sources.some((source) => source.id === id),
      `Packaged adapter missing: ${id}`,
    );
  const stateBefore = JSON.parse(await readFile(profile + '/engine.json', 'utf8'));
  const child = spawn(executablePath, appArgs, {
    env: desktopEnv,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((ok, fail) => {
    child.once('error', fail);
    child.once('exit', () => ok());
  });
  const stateAfter = JSON.parse(await readFile(profile + '/engine.json', 'utf8'));
  report.repeatLaunchUsesSameEngine =
    stateBefore.pid === stateAfter.pid && stateBefore.port === stateAfter.port;
  const attach = spawn(process.execPath, ['dist/engine/cli.js'], {
    env: { ...process.env, REVANIME_DATA_DIR: profile },
    stdio: 'ignore',
    windowsHide: true,
  });
  report.browserModeAttaches = await new Promise<boolean>((ok, fail) => {
    attach.once('error', fail);
    attach.once('exit', (code) => ok(code === 0));
  });
  assert.equal(report.repeatLaunchUsesSameEngine, true);
  assert.equal(report.browserModeAttaches, true);
  await page.goto(new URL('/catalog', page.url()).href);
  await page.getByRole('heading', { name: '番剧索引', exact: true }).waitFor();
  await page.getByRole('group', { name: '年份筛选' }).waitFor();
  await page.getByRole('button', { name: 'AkiAnime', exact: true }).click();
  await page.getByRole('group', { name: '题材筛选' }).waitFor();
  for (const [name, filter] of [
    ['咕咕动漫', '题材筛选'],
    ['乐豆动漫', '地区筛选'],
    ['稀饭动漫', '类型筛选'],
  ]) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('group', { name: filter }).waitFor();
  }
  report.catalogNavigation = true;
  await page.screenshot({ path: `output/playwright/desktop-catalog-${APP_VERSION}.png` });
  await page.goto(new URL('/calendar', page.url()).href);
  await page.getByRole('heading', { name: '每周放送', exact: true }).waitFor();
  await page.getByRole('tab').first().waitFor();
  assert.equal(await page.getByRole('tab').count(), 7);
  report.weekdayNavigation = true;
  await page.goto(new URL('/search', page.url()).href);
  await page.getByRole('heading', { name: '最近搜索', exact: true }).waitFor();
  report.searchLanding = true;
  await page.goto(new URL('/settings', page.url()).href);
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.waitForFunction(
    async () => (await (await fetch('/api/v1/settings')).json()).appearance === 'light',
  );
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  report.lightAppearancePersists = true;
  await page.screenshot({ path: `output/playwright/desktop-settings-light-${APP_VERSION}.png` });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  assert.equal(
    await page
      .getByRole('textbox', { name: '搜索番剧' })
      .evaluate((input) => document.activeElement === input),
    true,
  );
  report.searchShortcut = true;
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForFunction(
    async () => (await (await fetch('/api/v1/settings')).json()).appearance === 'dark',
  );
  const resumed = page.waitForEvent('domcontentloaded');
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('resume');
  });
  await resumed;
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  report.resumeEventReloads = true;
  // Decode the repository's original fixtures in the packaged Electron runtime.
  await page.route('**/__desktop_validation/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
    if (name === 'hls.js')
      return route.fulfill({
        path: resolve('node_modules/hls.js/dist/hls.min.js'),
        contentType: 'application/javascript',
      });
    if (!/^(sample\.mp4|index\.m3u8|segment-\d\d\.ts)$/.test(name)) return route.abort();
    await route.fulfill({
      path: resolve('tests/fixtures/media', name),
      contentType: name.endsWith('.mp4')
        ? 'video/mp4'
        : name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t',
    });
  });
  await page.addScriptTag({ url: '/__desktop_validation/hls.js' });
  // A string keeps nested browser functions free of tsx's Node-side helpers.
  report.media = await page.evaluate(`(async () => {
    async function decode(hls) {
      const video = document.createElement('video');
      video.muted = true;
      document.body.append(video);
      const player = hls ? new window.Hls() : undefined;
      try {
        if (player) {
          player.loadSource('/__desktop_validation/index.m3u8');
          player.attachMedia(video);
        } else video.src = '/__desktop_validation/sample.mp4';
        return await new Promise((ok, fail) => {
          const timeout = setTimeout(() => { cleanup(); fail(new Error('Packaged video decode timed out')); }, 15000);
          const check = setInterval(() => {
            if (video.currentTime > 0.5 && video.videoWidth > 0) {
              cleanup();
              ok({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime });
            }
          }, 100);
          function cleanup() { clearTimeout(timeout); clearInterval(check); }
          void video.play().catch((error) => { cleanup(); fail(error); });
        });
      } finally {
        video.pause();
        player?.destroy();
        video.removeAttribute('src');
        video.load();
        video.remove();
      }
    }
    return { mp4: await decode(false), hls: await decode(true) };
  })()`);
  const media = report.media as Record<string, { width: number; height: number; time: number }>;
  for (const format of ['mp4', 'hls']) {
    assert.ok(media?.[format]?.width > 0, `${format} must decode video frames`);
    assert.ok(media?.[format]?.time > 0.5, `${format} must advance playback`);
  }
  await page.screenshot({ path: `output/playwright/desktop-settings-${APP_VERSION}.png` });
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error).slice(0, 1000);
  throw error;
} finally {
  await app.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(report);
