import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../packages/engine/src/errors';
import { startOrAttach } from '../packages/engine/src/runtime';

const dirs: string[] = [];
const engines: Awaited<ReturnType<typeof startOrAttach>>[] = [];
const profile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revanime-runtime-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('single local engine', () => {
  it('rejects persisted browser credentials after the engine is restarted', async () => {
    const dir = await profile();
    const first = await startOrAttach('/missing-web-dir', dir);
    engines.push(first);
    const boot = await fetch(first.bootstrapUrl, { redirect: 'manual' });
    const oldCookie = boot.headers.get('set-cookie')!.split(';')[0];
    await first.close();

    const next = await startOrAttach('/missing-web-dir', dir);
    engines.push(next);
    expect(next.state.token).not.toBe(first.state.token);
    const denied = await fetch(next.origin + '/api/v1/sources', { headers: { cookie: oldCookie } });
    expect(denied.status).toBe(401);
    const expired = await fetch(next.origin + '/bootstrap?token=' + first.state.token, {
      redirect: 'manual',
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('set-cookie')).toBeNull();

    const reopened = await fetch(next.bootstrapUrl, { redirect: 'manual' });
    const cookie = reopened.headers.get('set-cookie')!.split(';')[0];
    const connected = await fetch(next.origin + '/api/v1/sources', { headers: { cookie } });
    expect(connected.status).toBe(200);
  });
  it('arbitrates concurrent startups and shares one authenticated engine', async () => {
    const dir = await profile();
    const pair = await Promise.all([
      startOrAttach('/missing-web-dir', dir),
      startOrAttach('/missing-web-dir', dir),
    ]);
    engines.push(...pair);
    expect(pair.filter((engine) => engine.owned)).toHaveLength(1);
    expect(pair[0].origin).toBe(pair[1].origin);
    expect(pair[0].state.token).toBe(pair[1].state.token);
    const r = await fetch(pair[0].origin + '/api/v1/settings', {
      headers: { Authorization: 'Bearer ' + pair[1].state.token },
    });
    expect(r.status).toBe(200);
    expect(new URL(pair[0].origin).hostname).toBe('127.0.0.1');
  });
  it('recovers a lock and stale port left behind by a dead process', async () => {
    const dir = await profile();
    await writeFile(join(dir, 'engine.lock'), JSON.stringify({ pid: 999999999 }));
    await writeFile(
      join(dir, 'engine.json'),
      JSON.stringify({ version: 1, pid: 999999999, port: 1, token: 'f'.repeat(64) }),
    );
    const engine = await startOrAttach('/missing-web-dir', dir);
    engines.push(engine);
    expect(engine.owned).toBe(true);
    expect(engine.state.port).toBeGreaterThan(1);
  });
  it('replaces an empty lock that is older than two seconds', async () => {
    const dir = await profile();
    const lockPath = join(dir, 'engine.lock');
    await writeFile(lockPath, '');
    const stale = new Date(Date.now() - 3000);
    await utimes(lockPath, stale, stale);
    const engine = await startOrAttach('/missing-web-dir', dir);
    engines.push(engine);
    expect(engine.owned).toBe(true);
  });
  it('serializes concurrent recovery of the same stale lock', async () => {
    const dir = await profile();
    await writeFile(join(dir, 'engine.lock'), JSON.stringify({ pid: 999999999 }));
    const started = await Promise.all(
      Array.from({ length: 6 }, () => startOrAttach('/missing-web-dir', dir)),
    );
    engines.push(...started);
    expect(started.filter((engine) => engine.owned)).toHaveLength(1);
    expect(new Set(started.map((engine) => engine.origin)).size).toBe(1);
    const attached = started.find((engine) => !engine.owned)!;
    await attached.close();
    expect(existsSync(join(dir, 'engine.lock'))).toBe(true);
    expect(existsSync(join(dir, 'engine-startup.sqlite'))).toBe(true);
  });
  it.each([
    { status: 200, acknowledgement: undefined, label: 'no shutdown acknowledgement' },
    { status: 503, acknowledgement: true, label: 'an HTTP error with an acknowledgement body' },
    { status: 200, acknowledgement: 'true', label: 'a non-boolean acknowledgement' },
  ])('rejects another live version after the short wait for $label', async ({ status, acknowledgement }) => {
    const dir = await profile();
    const fake = createHttpServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/shutdown' && acknowledgement !== undefined) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ shuttingDown: acknowledgement }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'revanime', pid: process.pid, version: '0.0.0-old' }));
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = fake.address() as AddressInfo;
      await writeFile(
        join(dir, 'engine.json'),
        JSON.stringify({ version: 1, pid: process.pid, port, token: 'a'.repeat(64) }),
      );
      await expect(startOrAttach('/missing-web-dir', dir)).rejects.toMatchObject({
        code: 'ENGINE_VERSION',
        status: 409,
      } satisfies Partial<AppError>);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('shuts down through the authenticated API and removes the lock', async () => {
    const dir = await profile();
    const engine = await startOrAttach('/missing-web-dir', dir);
    engines.push(engine);
    const response = await fetch(engine.origin + '/api/v1/shutdown', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + engine.state.token },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shuttingDown: true });
    const deadline = Date.now() + 5000;
    let healthFailed = false;
    while (Date.now() < deadline) {
      try {
        await fetch(engine.origin + '/api/v1/health', {
          headers: { Authorization: 'Bearer ' + engine.state.token },
          signal: AbortSignal.timeout(300),
        });
      } catch {
        healthFailed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(healthFailed).toBe(true);
    while (Date.now() < deadline && existsSync(join(dir, 'engine.lock')))
      await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(dir, 'engine.lock'))).toBe(false);
  });
  it.each([0, 3500])(
    'accepts acknowledged cleanup taking %i ms while the old host PID stays alive',
    async (delay) => {
      const dir = await profile();
      const statePath = join(dir, 'engine.json');
      const lockPath = join(dir, 'engine.lock');
      const oldLock = JSON.stringify({ pid: process.pid, owner: 'old-engine' });
      let cleanup: Promise<void> | undefined;
      let keptOriginalLock = false;
      const fake = createHttpServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/api/v1/shutdown') {
          res.end(JSON.stringify({ shuttingDown: true }));
          cleanup = new Promise<void>((resolve) => setTimeout(resolve, delay)).then(async () => {
            keptOriginalLock = (await readFile(lockPath, 'utf8')) === oldLock;
            await Promise.all([rm(statePath), rm(lockPath)]);
          });
          void cleanup.catch(() => {});
        } else res.end(JSON.stringify({ app: 'revanime', pid: process.pid, version: 'old' }));
      });
      await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = fake.address() as AddressInfo;
        await writeFile(
          statePath,
          JSON.stringify({ version: 1, pid: process.pid, port, token: 'a'.repeat(64) }),
        );
        await writeFile(lockPath, oldLock);
        const replacement = await startOrAttach('/missing-web-dir', dir);
        engines.push(replacement);
        expect(replacement.owned).toBe(true);
        expect(replacement.state.port).not.toBe(port);
        expect(keptOriginalLock).toBe(true);
      } finally {
        await cleanup;
        await new Promise<void>((resolve) => fake.close(() => resolve()));
      }
    },
  );
});
