import { afterEach, expect, it, vi } from 'vitest';
import { RequestCache } from '../packages/engine/src/request-cache';

afterEach(() => vi.restoreAllMocks());
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it('shares an upstream read while cancelling one window leaves another window running', async () => {
  const cache = new RequestCache(),
    value = deferred<number>(),
    first = new AbortController();
  let upstream!: AbortSignal;
  const read = vi.fn((signal: AbortSignal) => {
    upstream = signal;
    return value.promise;
  });
  const a = cache.load('catalog', read, { signal: first.signal });
  const b = cache.load('catalog', read);
  await Promise.resolve();
  first.abort();
  await expect(a).rejects.toHaveProperty('name', 'AbortError');
  expect(upstream.aborted).toBe(false);
  value.resolve(7);
  expect(await b).toBe(7);
  expect(await cache.load('catalog', read)).toBe(7);
  expect(read).toHaveBeenCalledOnce();
});

it('aborts an unused read and lets a new visitor start instead of joining the cancelled request', async () => {
  const cache = new RequestCache(),
    controller = new AbortController();
  let upstream!: AbortSignal;
  const abandoned = cache.load(
    'detail',
    (signal) => {
      upstream = signal;
      return new Promise(() => {});
    },
    { signal: controller.signal },
  );
  await Promise.resolve();
  controller.abort();
  await expect(abandoned).rejects.toHaveProperty('name', 'AbortError');
  expect(upstream.aborted).toBe(true);
  expect(await cache.load('detail', async () => 'fresh')).toBe('fresh');
});

it('clear prevents an old pending response from overwriting a newer read', async () => {
  const cache = new RequestCache(),
    old = deferred<string>();
  const waiting = cache.load('home', () => old.promise);
  await Promise.resolve();
  cache.clear();
  expect(await cache.load('home', async () => 'new')).toBe('new');
  old.resolve('old');
  expect(await waiting).toBe('old');
  expect(cache.peek('home')).toBe('new');
});

it('refresh ignores a saved value and concurrent refreshes share the new read', async () => {
  const cache = new RequestCache(),
    next = deferred<string>();
  await cache.load('home', async () => 'old');
  const read = vi.fn(() => next.promise);
  const a = cache.load('home', read, { refresh: true });
  const b = cache.load('home', read, { refresh: true });
  next.resolve('new');
  expect(await Promise.all([a, b])).toEqual(['new', 'new']);
  expect(read).toHaveBeenCalledOnce();
  expect(cache.peek('home')).toBe('new');
});

it('does not cache failures or serve an expired value', async () => {
  const cache = new RequestCache();
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await expect(
    cache.load('home', async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
  expect(await cache.load('home', async () => 'ok', { ttl: 100 })).toBe('ok');
  now += 101;
  expect(cache.peek('home')).toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  const read = vi.fn(async () => 'must not run');
  await expect(cache.load('home', read, { signal: controller.signal })).rejects.toHaveProperty(
    'name',
    'AbortError',
  );
  expect(read).not.toHaveBeenCalled();
});

it('evicts the least recently read entry when the metadata cache is full', async () => {
  const cache = new RequestCache(2);
  await cache.load('a', async () => 1);
  await cache.load('b', async () => 2);
  cache.peek('a');
  await cache.load('c', async () => 3);
  expect(cache.peek('a')).toBe(1);
  expect(cache.peek('b')).toBeUndefined();
});

it('lets a non-refresh load join an in-flight refresh', async () => {
  const cache = new RequestCache(),
    next = deferred<string>();
  const read = vi.fn(() => next.promise);
  const refreshed = cache.load('home', read, { refresh: true });
  const joined = cache.load('home', read);
  next.resolve('fresh');
  expect(await Promise.all([refreshed, joined])).toEqual(['fresh', 'fresh']);
  expect(read).toHaveBeenCalledOnce();
  expect(cache.peek('home')).toBe('fresh');
});

it('does not join a non-refresh load and a stale read cannot overwrite a refresh', async () => {
  const cache = new RequestCache(),
    stale = deferred<string>(),
    fresh = deferred<string>();
  let calls = 0;
  const read = vi.fn(() => (++calls === 1 ? stale.promise : fresh.promise));
  const slow = cache.load('home', read);
  await Promise.resolve();
  const refreshed = cache.load('home', read, { refresh: true });
  await Promise.resolve();
  fresh.resolve('fresh');
  expect(await refreshed).toBe('fresh');
  expect(cache.peek('home')).toBe('fresh');
  stale.resolve('stale');
  expect(await slow).toBe('stale');
  expect(cache.peek('home')).toBe('fresh');
  expect(read).toHaveBeenCalledTimes(2);
});

it('does not merge cookie-dependent pending reads across search pages', async () => {
  const cache = new RequestCache(),
    a = deferred<string>(),
    b = deferred<string>();
  const first = cache.load('same-keyword', () => a.promise, { deduplicate: false });
  const second = cache.load('same-keyword', () => b.promise, { deduplicate: false });
  b.resolve('window-b');
  expect(await second).toBe('window-b');
  a.resolve('window-a');
  expect(await first).toBe('window-a');
  expect(await cache.load('same-keyword', async () => 'unused')).toBe('window-a');
});

it('releases refresh bookkeeping after completed reads and clears old generations', async () => {
  const cache = new RequestCache(2);
  for (let i = 0; i < 1000; i++) await cache.load(`item-${i}`, async () => i, { refresh: true });
  // This is a memory bound, not merely an eviction check of returned values.
  const state = cache as unknown as { reads: Map<string, unknown>; values: Map<string, unknown> };
  expect(state.values.size).toBe(2);
  expect(state.reads.size).toBe(0);
  const old = deferred<string>();
  const pending = cache.load('detail', () => old.promise, { refresh: true });
  cache.clear();
  expect(state.reads.size).toBe(0);
  expect(await cache.load('detail', async () => 'new', { refresh: true })).toBe('new');
  old.resolve('old');
  expect(await pending).toBe('old');
  expect(cache.peek('detail')).toBe('new');
  expect(state.reads.size).toBe(0);
});
