import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../packages/engine/src/store';
import { Registry } from '../packages/engine/src/registry';
import { MediaGateway } from '../packages/engine/src/media';
import { card, episode, fakeSource, response } from '../tests/helpers';
import type { EngineState } from '../packages/engine/src/runtime';

const profile = resolve('.cache/crash-validation');
await mkdir(profile, { recursive: true });
const start = async () => {
  const child = spawn(process.execPath, ['dist/engine/cli.js'], {
    env: { ...process.env, REVANIME_DATA_DIR: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('Startup timeout')), 10000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      ok();
    });
    child.once('exit', (code) => {
      if (code) {
        clearTimeout(timer);
        fail(new Error('Startup failed'));
      }
    });
  });
  const state: EngineState = JSON.parse(await readFile(profile + '/engine.json', 'utf8'));
  const api = async (path: string, init?: RequestInit) => {
    const r = await fetch(`http://127.0.0.1:${state.port}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + state.token,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    if (!r.ok) throw new Error('Local API ' + r.status);
    return r.json();
  };
  return { child, api };
};
const first = await start();
await first.api('/history', {
  method: 'POST',
  body: JSON.stringify({
    card: { ...card, sourceId: 'anich', id: 'fixture' },
    episode: {
      ...episode(),
      locator: { sourceId: 'anich', animeId: 'fixture', lineId: 'auto', episodeId: '1' },
    },
    position: 83.25,
    duration: 240,
  }),
});
await new Promise<void>((resolve) => {
  first.child.once('exit', () => resolve());
  first.child.kill('SIGKILL');
});
const second = await start();
const saved = await second.api('/history');
await new Promise<void>((resolve) => {
  second.child.once('exit', () => resolve());
  second.child.kill('SIGTERM');
});
const store = new Store(':memory:');
const registry = new Registry(store, [fakeSource()]);
const gateway = new MediaGateway(registry);
const bytes = await readFile('tests/fixtures/media/sample.mp4');
registry.context('fixture').http.stream = async (url) => ({
  url,
  response: response(bytes, { 'content-type': 'video/mp4', 'content-length': String(bytes.length) }),
});
const measurements = [];
for (let cycle = 0; cycle < 3; cycle++) {
  for (let i = 0; i < 100; i++) {
    const p = await gateway.create(episode().locator);
    const r = await gateway.open(p.sessionId, p.url.split('/').at(-1)!);
    for await (const _chunk of r.body) {
      /* consume with backpressure */
    }
    gateway.delete(p.sessionId);
  }
  global.gc?.();
  measurements.push(process.memoryUsage());
}
store.close();
const report = {
  checkedAt: new Date().toISOString(),
  abruptExit: {
    signal: 'SIGKILL',
    expected: 83.25,
    recovered: saved[0]?.position,
    ok: saved[0]?.position === 83.25,
  },
  mediaCycles: {
    iterations: 300,
    bytesPerCycle: bytes.length,
    measurements,
    note: 'In-process fixture streaming, forced GC; not a long-term leak proof.',
  },
};
await writeFile('docs/validation/resilience.json', JSON.stringify(report, null, 2) + '\n');
console.log(report.abruptExit);
