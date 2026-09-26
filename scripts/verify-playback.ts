// Opt-in checks against live providers. No media URLs, cookies or parser tokens are persisted.
import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EngineState } from '../packages/engine/src/runtime';
import type { Episode, HomeSection, SourceDetail } from '../packages/core/src/types';

const profile = resolve(process.env.REVANIME_DATA_DIR ?? '.cache/local-preview');
const state: EngineState = JSON.parse(await readFile(profile + '/engine.json', 'utf8'));
const origin = `http://127.0.0.1:${state.port}`;
const full = process.argv.includes('--full');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const startedAt = new Date().toISOString();
const results: Record<string, unknown>[] = [];
await mkdir('docs/validation', { recursive: true });
const output =
  process.env.VALIDATION_OUTPUT ?? `docs/validation/live-${full ? 'full-episode' : 'starts'}.json`;
const save = () =>
  writeFile(
    output,
    JSON.stringify(
      {
        startedAt,
        checkedAt: new Date().toISOString(),
        browser: browser.version(),
        mode: full ? 'continuous-playback-at-1x' : 'start-seek-resume',
        results,
      },
      null,
      2,
    ) + '\n',
  );
try {
  await Promise.all(
    (process.env.VALIDATION_SOURCE ? [process.env.VALIDATION_SOURCE] : ['anich', 'aki']).map(
      async (sourceId) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.request.get(`${origin}/bootstrap?token=${state.token}`);
        const settings = await (await context.request.get(origin + '/api/v1/settings')).json();
        await context.request.put(origin + '/api/v1/settings', {
          data: { ...settings, autoNext: false, playbackRate: 1, volume: 0 },
        });
        const page = await context.newPage();
        const networkErrors: { status: number; path: string }[] = [];
        page.on('response', (response) => {
          if (response.status() < 400 || !response.url().startsWith(origin + '/api/v1/')) return;
          networkErrors.push({
            status: response.status(),
            path: new URL(response.url()).pathname.replace(/\/media\/.*/, '/media/[resource]'),
          });
          if (networkErrors.length > 20) networkErrors.shift();
        });
        const detail = async (id: string) => {
          const response = await context.request.get(
            `${origin}/api/v1/sources/${sourceId}/detail?itemId=${id}`,
            { timeout: 60_000 },
          );
          if (!response.ok()) throw new Error(`Detail HTTP ${response.status()}`);
          return (await response.json()) as SourceDetail;
        };
        const ids =
          process.env.VALIDATION_IDS?.split(',') ??
          (sourceId === 'anich'
            ? ['38493', '37654', '32339', '38373', '38359', '38374']
            : ['N3cDDE', 'u3cDDE', 'G3cDDE', '1EcDDE', 'dPDDDE']);
        let attempted = 0;
        for (const id of ids) {
          if (attempted >= (full ? 1 : 10)) break;
          let data: SourceDetail;
          try {
            data = await detail(id);
          } catch (error) {
            results.push({ sourceId, animeId: id, stage: 'detail', ok: false, error: String(error) });
            await save();
            continue;
          }
          // Aki's YDY public parser is the implemented route; legacy external HLS routes are not a release claim.
          const line =
            sourceId === 'aki'
              ? data.lines.find((l) => l.id === (id === 'dPDDDE' ? '5' : '1'))
              : data.lines[0];
          if (!line) continue;
          for (const episode of line.episodes.slice(0, full ? 1 : 2)) {
            if (attempted++ >= (full ? 1 : 10)) break;
            const began = Date.now();
            networkErrors.length = 0;
            const sample: Record<string, unknown> = {
              sourceId,
              animeId: id,
              title: data.title,
              locator: episode.locator,
              ok: false,
            };
            results.push(sample);
            try {
              await page.goto(
                `${origin}/watch/${sourceId}/${id}?line=${line.id}&episode=${episode.id}&resume=0`,
              );
              await page.waitForSelector('video', { timeout: 60_000 });
              await page.locator('video').evaluate((video: HTMLVideoElement) => {
                video.muted = true;
                void video.play().catch(() => {});
              });
              await page.waitForFunction(
                () => {
                  const v = document.querySelector('video');
                  return (
                    v &&
                    v.currentTime > 2 &&
                    v.readyState >= 2 &&
                    v.videoWidth > 0 &&
                    v.getVideoPlaybackQuality().totalVideoFrames > 0
                  );
                },
                undefined,
                { timeout: 90_000 },
              );
              sample.startMs = Date.now() - began;
              const metadata = await page.locator('video').evaluate((v: HTMLVideoElement) => ({
                duration: v.duration,
                width: v.videoWidth,
                height: v.videoHeight,
                frames: v.getVideoPlaybackQuality().totalVideoFrames,
              }));
              Object.assign(sample, metadata);
              console.log(sourceId, id, episode.id, 'playing', metadata.duration);
              if (full) {
                let previous = 0;
                let stalledAt = Date.now();
                while (Date.now() - began < (metadata.duration + 300) * 1000) {
                  const status = await page.locator('video').evaluate((v: HTMLVideoElement) => ({
                    time: v.currentTime,
                    ended: v.ended,
                    paused: v.paused,
                    error: v.error?.code,
                    frames: v.getVideoPlaybackQuality().totalVideoFrames,
                    dropped: v.getVideoPlaybackQuality().droppedVideoFrames,
                  }));
                  sample.last = status;
                  sample.elapsedSeconds = Math.round((Date.now() - began) / 1000);
                  if (status.ended) {
                    sample.ok = true;
                    break;
                  }
                  // Give the application's bounded address refresh a chance to finish.
                  // Persistent errors still hit the no-progress deadline below.
                  if (status.time > previous + 0.1) {
                    previous = status.time;
                    stalledAt = Date.now();
                  }
                  if (Date.now() - stalledAt > 120_000)
                    throw new Error('Playback made no progress for 120 seconds');
                  if (status.paused && !status.error)
                    await page.locator('video').evaluate((v: HTMLVideoElement) => v.play().catch(() => {}));
                  console.log(
                    sourceId,
                    'continuous',
                    Math.floor(status.time),
                    '/',
                    Math.floor(metadata.duration),
                  );
                  await save();
                  await new Promise((r) => setTimeout(r, 30_000));
                }
                if (!sample.ok) throw new Error('Continuous playback deadline exceeded');
              } else {
                const target = Math.min(90, metadata.duration / 2);
                await page.locator('video').evaluate((v: HTMLVideoElement, t) => {
                  v.currentTime = t;
                }, target);
                await page.waitForFunction(
                  (t) => {
                    const v = document.querySelector('video');
                    return v && v.currentTime > t + 1 && v.readyState >= 2;
                  },
                  target,
                  { timeout: 45_000 },
                );
                await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
                const position = await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
                await page.waitForTimeout(1000);
                await page.goto(origin + '/history');
                await page.goto(`${origin}/watch/${sourceId}/${id}?line=${line.id}&episode=${episode.id}`);
                await page.waitForFunction(
                  (t) => {
                    const v = document.querySelector('video');
                    return v && v.readyState >= 2 && Math.abs(v.currentTime - t) <= 5;
                  },
                  position,
                  { timeout: 90_000 },
                );
                const resumed = await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
                Object.assign(sample, {
                  ok: true,
                  seek: target,
                  savedPosition: position,
                  resumedPosition: resumed,
                  resumeError: Math.abs(resumed - position),
                });
              }
            } catch (error) {
              sample.playerMessage = (
                await page
                  .getByRole('alert')
                  .allTextContents()
                  .catch(() => [])
              ).map((s) => s.replace(/https?:\/\/[^\s]+/g, '[redacted URL]').slice(0, 300));
              sample.networkErrors = [...networkErrors];
              sample.error = String(error)
                .replace(/https?:\/\/[^\s]+/g, '[redacted URL]')
                .slice(0, 1000);
              console.log(sourceId, id, episode.id, 'failed', sample.error);
            }
            await save();
          }
        }
        await context.close();
      },
    ),
  );
} finally {
  await save();
  await browser.close();
}
console.log('Saved', output);
