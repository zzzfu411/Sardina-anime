import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SourcePreferences } from '../apps/web/src/source-preferences';
import type { AppSettings } from '../packages/core/src/types';
import { Store } from '../packages/engine/src/store';
import { createServer } from '../packages/engine/src/server';
import { discoverySource, fakeSource } from './helpers';

const firstGeneration = '11111111-1111-4111-8111-111111111111';
const nextGeneration = '22222222-2222-4222-8222-222222222222';

const settings = (
  revision: number,
  sourcePreferences: AppSettings['sourcePreferences'] = {},
): AppSettings => ({
  autoNext: true,
  volume: 0.8,
  playbackRate: 1,
  revision,
  generation: firstGeneration,
  sourcePreferences,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

it('stores independent source choices in the profile across reopen and preserves old backup compatibility', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anime-source-preferences-'));
  const path = join(directory, 'profile.sqlite');
  let store = new Store(path);
  try {
    const first = store.saveSourcePreference('search', 'offline');
    const second = store.saveSourcePreference('home', 'fixture');
    expect(second.sourcePreferences).toEqual({ search: 'offline', home: 'fixture' });
    expect(second.revision).toBe((first.revision ?? 0) + 1);
    expect(store.saveSourcePreference('home', 'fixture').revision).toBe(second.revision);
    const backup = store.export();
    store.close();
    store = new Store(path);
    expect(store.settings().sourcePreferences).toEqual(backup.settings.sourcePreferences);
    const { sourcePreferences: _oldMissingField, ...oldSettings } = backup.settings;
    store.restore({ ...backup, settings: oldSettings });
    expect(store.settings().sourcePreferences).toBeUndefined();
    store.restore(backup);
    expect(store.settings().sourcePreferences).toEqual({ search: 'offline', home: 'fixture' });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('atomically merges concurrent modules, validates sources and rejects stale whole-settings writes', async () => {
  const server = await createServer({
    database: ':memory:',
    token: 'preference-test',
    sources: [discoverySource(), fakeSource('offline')],
    updates: false,
  });
  const headers = { host: '127.0.0.1', authorization: 'Bearer preference-test' };
  const url = '/api/v1/settings/source-preferences';
  try {
    const before = (await server.app.inject({ url: '/api/v1/settings', headers })).json();
    const results = await Promise.all(
      Object.entries({ search: 'offline', home: 'fixture', catalog: 'fixture', schedule: 'fixture' }).map(
        ([module, sourceId]) =>
          server.app.inject({
            method: 'PATCH',
            url,
            headers,
            payload: { module, sourceId, generation: before.generation },
          }),
      ),
    );
    expect(results.every((result) => result.statusCode === 200)).toBe(true);
    const saved = (await server.app.inject({ url: '/api/v1/settings', headers })).json();
    expect(saved.sourcePreferences).toEqual({
      search: 'offline',
      home: 'fixture',
      catalog: 'fixture',
      schedule: 'fixture',
    });
    expect(saved.volume).toBe(before.volume);
    expect(saved.revision).toBe(before.revision + 4);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: '/api/v1/settings',
          headers,
          payload: { ...before, volume: 0.1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: { module: 'catalog', sourceId: 'offline' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: { module: 'unexpected', sourceId: 'fixture' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url,
          headers,
          payload: { module: 'search', sourceId: 'missing' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server.app.inject({
          method: 'PATCH',
          url,
          headers: { host: '127.0.0.1' },
          payload: { module: 'search', sourceId: 'fixture' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await server.app.inject({ url: '/api/v1/settings', headers })).json()).toEqual(saved);
  } finally {
    await server.app.close();
  }
});

it('keeps the latest manual source visible while serializing quick changes and ignoring late reads', async () => {
  const first = deferred<AppSettings>();
  const second = deferred<AppSettings>();
  const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const preferences = new SourcePreferences({ send });
  preferences.accept(settings(1, { search: 'fixture' }));
  preferences.choose('search', 'a');
  preferences.choose('search', 'b');
  preferences.accept(settings(2, { search: 'fixture' }));
  expect(preferences.read('search')).toBe('b');
  expect(send.mock.calls).toEqual([['search', 'a', firstGeneration]]);
  first.resolve(settings(3, { search: 'a' }));
  await Promise.resolve();
  expect(send.mock.calls).toEqual([
    ['search', 'a', firstGeneration],
    ['search', 'b', firstGeneration],
  ]);
  expect(preferences.read('search')).toBe('b');
  second.resolve(settings(4, { search: 'b' }));
  await preferences.flush('search');
  preferences.accept(settings(1, { search: 'fixture' }));
  expect(preferences.read('search')).toBe('b');
});

it('handles out-of-order acknowledgements between modules without publishing older settings', async () => {
  const first = deferred<AppSettings>();
  const second = deferred<AppSettings>();
  const saved = vi.fn();
  const preferences = new SourcePreferences({
    send: (module) => (module === 'search' ? first.promise : second.promise),
    saved,
  });
  preferences.accept(settings(0));
  preferences.choose('search', 'offline');
  preferences.choose('home', 'fixture');
  second.resolve(settings(2, { search: 'offline', home: 'fixture' }));
  await preferences.flush('home');
  first.resolve(settings(1, { search: 'offline' }));
  await preferences.flush('search');
  expect(saved).toHaveBeenCalledTimes(1);
  expect(preferences.read('search')).toBe('offline');
  expect(preferences.read('home')).toBe('fixture');
});

it('reports save failures while preserving the immediate choice and retries without repeated notices', async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('still offline'))
    .mockResolvedValueOnce(settings(1, { catalog: 'fixture' }));
  const failed = vi.fn();
  const preferences = new SourcePreferences({ send, failed });
  preferences.accept(settings(0, { catalog: 'old' }));
  preferences.choose('catalog', 'fixture');
  await preferences.flush('catalog');
  preferences.accept(settings(0, { catalog: 'old' }));
  expect(preferences.read('catalog')).toBe('fixture');
  preferences.retry();
  await preferences.flush('catalog');
  expect(failed).toHaveBeenCalledTimes(1);
  preferences.retry();
  await preferences.flush('catalog');
  expect(preferences.read('catalog')).toBe('fixture');
  expect(send).toHaveBeenCalledTimes(3);
});

it('waits for initial settings before binding and sending an early selection', async () => {
  const send = vi.fn().mockResolvedValue(settings(1, { search: 'offline' }));
  const preferences = new SourcePreferences({ send });
  preferences.choose('search', 'offline');
  expect(preferences.read('search')).toBe('offline');
  preferences.retry();
  await preferences.flush('search');
  expect(send).not.toHaveBeenCalled();
  preferences.accept(settings(0, { search: 'fixture' }));
  await preferences.flush('search');
  expect(send).toHaveBeenCalledExactlyOnceWith('search', 'offline', firstGeneration);
});

it('discards pending old-generation choices and ignores late acknowledgements after restore', async () => {
  const old = deferred<AppSettings>();
  const fresh = deferred<AppSettings>();
  const third = deferred<AppSettings>();
  const saved = vi.fn();
  const invalidated = vi.fn();
  const send = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise)
    .mockReturnValueOnce(third.promise);
  const preferences = new SourcePreferences({ send, saved, invalidated });
  preferences.accept(settings(0, { search: 'fixture' }));
  preferences.choose('search', 'old-pending');
  preferences.choose('search', 'old-queued');
  preferences.accept({ ...settings(4, { search: 'restored' }), generation: nextGeneration });
  expect(preferences.read('search')).toBe('restored');
  expect(invalidated).toHaveBeenCalledExactlyOnceWith(false);
  preferences.choose('search', 'fresh');
  expect(send).toHaveBeenCalledTimes(2);
  old.resolve(settings(3, { search: 'old-pending' }));
  await Promise.resolve();
  await Promise.resolve();
  preferences.choose('search', 'fresh-next');
  // An old worker's finally must not detach the still-running fresh worker.
  expect(send).toHaveBeenCalledTimes(2);
  fresh.resolve({ ...settings(5, { search: 'fresh' }), generation: nextGeneration });
  await Promise.resolve();
  expect(send).toHaveBeenLastCalledWith('search', 'fresh-next', nextGeneration);
  third.resolve({ ...settings(6, { search: 'fresh-next' }), generation: nextGeneration });
  await preferences.flush('search');
  expect(preferences.accept(settings(100, { search: 'late-old-read' }))).toBe(false);
  expect(preferences.read('search')).toBe('fresh-next');
  expect(saved.mock.calls.every(([value]) => value.generation === nextGeneration)).toBe(true);
});

it('a SETTINGS_CHANGED response drops old retries and requests fresh settings once', async () => {
  const changed = Object.assign(new Error('changed'), { code: 'SETTINGS_CHANGED' });
  const send = vi
    .fn()
    .mockRejectedValueOnce(changed)
    .mockResolvedValueOnce({ ...settings(3, { home: 'new-choice' }), generation: nextGeneration });
  const invalidated = vi.fn();
  const failed = vi.fn();
  const preferences = new SourcePreferences({ send, invalidated, failed });
  preferences.accept(settings(0, { home: 'fixture' }));
  preferences.choose('home', 'old-choice');
  await preferences.flush('home');
  preferences.retry();
  await preferences.flush('home');
  expect(send).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
  expect(invalidated).toHaveBeenCalledExactlyOnceWith(true);
  // A new deliberate choice waits for the new generation instead of borrowing the old one.
  preferences.choose('home', 'new-choice');
  expect(send).toHaveBeenCalledTimes(1);
  preferences.accept({ ...settings(2, { home: 'restored' }), generation: nextGeneration });
  await preferences.flush('home');
  expect(send).toHaveBeenLastCalledWith('home', 'new-choice', nextGeneration);
  expect(preferences.read('home')).toBe('new-choice');
});
