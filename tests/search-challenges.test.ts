import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SearchChallenge, SearchEvent } from '../packages/core/src/types';
import { SearchChallenges } from '../packages/engine/src/search-challenges';
import { SearchChallengeError } from '../packages/engine/src/errors';
import { Registry } from '../packages/engine/src/registry';
import { Store } from '../packages/engine/src/store';
import { createServer } from '../packages/engine/src/server';
import { captchaSource } from './captcha-fixture';
import { fakeSource } from './helpers';

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const setup = () => {
  const manager = new SearchChallenges(),
    source = captchaSource();
  cleanups.push(() => manager.close());
  return { manager, source };
};
async function challenge(operation: Promise<unknown>): Promise<SearchChallenge> {
  try {
    await operation;
    throw new Error('Expected a challenge');
  } catch (error) {
    if (error instanceof SearchChallengeError) return error.challenge;
    throw error;
  }
}

it('waits for a human without keeping the search deadline running and preserves cookies for pagination', async () => {
  const { manager, source } = setup();
  const submit = vi.spyOn(source, 'submitSearchCaptcha');
  const owner = randomUUID(),
    controller = new AbortController();
  const image = await challenge(
    manager.search(source, { keyword: '星空', page: 1 }, owner, controller.signal),
  );
  expect(submit).not.toHaveBeenCalled();
  expect(manager.image(image.id).contentType).toBe('image/png');
  // SSE ends after returning the challenge; its cancellation cannot close the waiting session.
  controller.abort();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 13_000);
  const result = await manager.submit(image.id, '3572');
  expect(result).toMatchObject({ type: 'result', page: { items: [{ title: '星空' }], page: 1 } });
  expect(submit).toHaveBeenCalledOnce();
  expect(() => manager.image(image.id)).toThrow('过期');
  expect(await manager.search(source, { keyword: '星空', page: 2 }, owner)).toMatchObject({ page: 2 });
});

it('keeps simultaneous windows isolated even for identical keywords, and never auto-submits a new image', async () => {
  const { manager, source } = setup();
  const submit = vi.spyOn(source, 'submitSearchCaptcha');
  const a = await challenge(manager.search(source, { keyword: 'same', page: 1 }, 'window-a'));
  const b = await challenge(manager.search(source, { keyword: 'same', page: 1 }, 'window-b'));
  expect(a.id).not.toBe(b.id);
  await manager.submit(a.id, '3572');
  expect(manager.image(b.id).body.length).toBeGreaterThan(0);
  expect(await manager.submit(b.id, '0000')).toMatchObject({
    type: 'challenge',
    challenge: { message: expect.stringContaining('不正确') },
  });
  expect(submit).toHaveBeenCalledTimes(2);
  expect(() => manager.image(b.id)).toThrow('过期');
});

it('refresh invalidates old IDs and rejects non-numeric input before sending anything upstream', async () => {
  const { manager, source } = setup();
  const submit = vi.spyOn(source, 'submitSearchCaptcha');
  const first = await challenge(manager.search(source, { keyword: 'x', page: 1 }, 'owner'));
  const next = await manager.refresh(first.id);
  expect(next.type).toBe('challenge');
  await expect(manager.submit(first.id, '3572')).rejects.toMatchObject({ code: 'CAPTCHA_EXPIRED' });
  if (next.type !== 'challenge') throw new Error('Expected challenge');
  await expect(manager.submit(next.challenge.id, '123x')).rejects.toMatchObject({
    code: 'INVALID_CAPTCHA_CODE',
  });
  expect(submit).not.toHaveBeenCalled();
  await expect(manager.search(source, { keyword: 'another', page: 1 }, 'owner')).rejects.toMatchObject({
    code: 'INVALID_SEARCH_SESSION',
  });
  expect((await manager.submit(next.challenge.id, '3572')).type).toBe('result');
});

it('expires pictures and cancels only the requested search page', async () => {
  const { manager, source } = setup();
  const a = await challenge(manager.search(source, { keyword: 'x', page: 1 }, 'a'));
  const b = await challenge(manager.search(source, { keyword: 'x', page: 1 }, 'b'));
  manager.cancel('a');
  expect(() => manager.image(a.id)).toThrow('过期');
  expect(manager.image(b.id).body.length).toBeGreaterThan(0);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1);
  await expect(manager.submit(b.id, '3572')).rejects.toMatchObject({ code: 'CAPTCHA_EXPIRED' });
});

it('serializes mutations and cancels a pending submission without resurrecting its picture', async () => {
  const { manager, source } = setup();
  const current = await challenge(manager.search(source, { keyword: 'x', page: 1 }, 'owner'));
  let finish!: () => void;
  source.submitSearchCaptcha = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const submitting = manager.submit(current.id, '3572');
  await expect(manager.refresh(current.id)).rejects.toMatchObject({ code: 'CAPTCHA_BUSY' });
  manager.cancelChallenge(current.id);
  await expect(submitting).rejects.toHaveProperty('name', 'AbortError');
  finish();
  await Promise.resolve();
  expect(() => manager.image(current.id)).toThrow('过期');
});

it('emits a challenge and finishes other sources without merging simultaneous waiting sessions', async () => {
  const store = new Store(':memory:'),
    registry = new Registry(store, [captchaSource(), fakeSource('other')]);
  cleanups.push(() => {
    registry.close();
    store.close();
  });
  const a: SearchEvent[] = [],
    b: SearchEvent[] = [];
  await Promise.all([
    registry.search('same', {}, new AbortController().signal, (e) => a.push(e), false, {}, 'a'),
    registry.search('same', {}, new AbortController().signal, (e) => b.push(e), false, {}, 'b'),
  ]);
  expect(a.at(-1)).toEqual({ type: 'done' });
  expect(a).toContainEqual(expect.objectContaining({ type: 'result', sourceId: 'other' }));
  const ca = a.find((e) => e.type === 'challenge'),
    cb = b.find((e) => e.type === 'challenge');
  expect(ca).toBeDefined();
  expect(cb).toBeDefined();
  expect(ca?.challenge.id).not.toBe(cb?.challenge.id);
  expect(registry.states().find((s) => s.id === 'captcha')?.health.status).toBe('unknown');
  registry.clearCache();
  expect(() => registry.searchCaptchaImage(ca!.challenge.id)).toThrow('过期');
});

it('protects image/submit endpoints and returns local image links, with no provider credentials', async () => {
  const server = await createServer({
    database: ':memory:',
    sources: [captchaSource()],
    token: 'test-token',
    updates: false,
  });
  cleanups.push(() => server.app.close());
  const headers = { host: '127.0.0.1', authorization: 'Bearer test-token' };
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/v1/search?q=test&session=${randomUUID()}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  const events = response.body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as SearchEvent);
  const event = events.find((e) => e.type === 'challenge')!;
  expect(event.challenge.imageUrl).toMatch(/^\/api\/v1\/search\/challenges\//);
  expect(response.body).not.toMatch(/cookie|expected=|verified=|captcha\.example/i);
  const path = `/api/v1/search/challenges/${event.challenge.id}`;
  expect((await server.app.inject({ url: path + '/image', headers: { host: '127.0.0.1' } })).statusCode).toBe(
    401,
  );
  const image = await server.app.inject({ url: path + '/image', headers });
  expect(image.statusCode).toBe(200);
  expect(image.headers['content-type']).toContain('image/png');
  expect(image.headers['cache-control']).toBe('no-store');
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: path,
        headers: { ...headers, origin: 'https://foreign.example' },
        payload: { code: '3572' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await server.app.inject({ method: 'POST', url: path, headers, payload: { code: '12xx' } })).statusCode,
  ).toBe(400);
  const result = await server.app.inject({ method: 'POST', url: path, headers, payload: { code: '3572' } });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    type: 'result',
    page: { items: [{ title: 'test', imageUrl: expect.stringMatching(/^\/api\/v1\/images\//) }] },
  });
  expect((await server.app.inject({ url: path + '/image', headers })).statusCode).toBe(410);
});
