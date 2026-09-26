import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { episodeKey, type HistoryWrite } from '../packages/core/src/types';
import { Store, migrations } from '../packages/engine/src/store';
import { createServer } from '../packages/engine/src/server';
import { card, episode, fakeSource } from './helpers';

const stores: Store[] = [];
const dirs: string[] = [];
const open = () => {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
};
const sample = (n = 1): HistoryWrite => ({
  card,
  episode: episode(n),
  position: 9,
  duration: 24,
  capturedAt: '2026-06-01T00:00:00.000Z',
});
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('history mutation boundaries', () => {
  it('rejects another profile even when all deletion counters match, while accepting legacy versions', () => {
    const first = open(), second = open();
    const version = first.historyData.version(episode().locator);
    const other = second.historyData.version(episode().locator);
    expect(other).toMatchObject({ all: version.all, series: version.series, episode: version.episode });
    expect(other.profile).not.toBe(version.profile);
    expect(() => second.saveHistory({ ...sample(), version })).toThrow('观看记录已被删除或恢复');
    expect(second.history()).toEqual([]);
    expect(second.saveHistory({ ...sample(), version: { all: 0, series: 0, episode: 0 } }).position).toBe(9);
  });
  it('persists the profile identity across reopen and never exports or imports it with backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sardina-history-profile-'));
    dirs.push(dir);
    const filename = join(dir, 'profile.sqlite');
    const original = new Store(filename);
    const profile = original.historyData.version(episode().locator).profile;
    const backup = original.export();
    expect(JSON.stringify(backup)).not.toContain(profile!);
    original.close();
    const reopened = new Store(filename);
    stores.push(reopened);
    expect(reopened.historyData.version(episode().locator).profile).toBe(profile);
    reopened.restore(backup);
    expect(reopened.historyData.version(episode().locator).profile).toBe(profile);
    const other = open();
    const otherProfile = other.historyData.version(episode().locator).profile;
    other.restore(backup);
    expect(other.historyData.version(episode().locator).profile).toBe(otherProfile);
    expect(otherProfile).not.toBe(profile);
  });
  it('rejects delayed writes after a clear and accepts a deliberate new viewing session', () => {
    const store = open();
    const before = { ...sample(), version: store.historyData.version(episode().locator) };
    store.saveHistory(before);
    store.clearHistory();
    expect(() => store.saveHistory(before)).toThrow('观看记录已被删除或恢复');
    expect(() => store.saveHistory(sample())).toThrow('观看记录已被删除或恢复');
    const current = store.historyData.version(episode().locator);
    expect(current.all).toBeGreaterThan(before.version.all);
    expect(store.saveHistory({ ...sample(), position: 0, version: current }).position).toBe(0);
  });
  it('deletes one episode without invalidating concurrent saves for other episodes', () => {
    const store = open();
    const one = { ...sample(), version: store.historyData.version(episode().locator) };
    const two = { ...sample(2), version: store.historyData.version(episode(2).locator) };
    store.saveHistory(one);
    store.historyData.delete({ key: episodeKey(episode().locator) });
    expect(() => store.saveHistory(one)).toThrow();
    expect(store.saveHistory(two).position).toBe(9);
    expect(store.history()).toHaveLength(1);
  });
  it('fences all episodes of a deleted series, including progress that had not arrived yet', () => {
    const store = open();
    const delayed = { ...sample(80), version: store.historyData.version(episode(80).locator) };
    store.historyData.delete({ refs: [card] });
    expect(() => store.saveHistory(delayed)).toThrow();
    expect(store.history()).toHaveLength(0);
    const ref = { ...card, id: 'different' };
    expect(
      store.saveHistory({
        ...sample(),
        card: ref,
        episode: { ...episode(), locator: { ...episode().locator, animeId: ref.id } },
      }).position,
    ).toBe(9);
  });
  it('advances the global boundary on restore so an old player cannot overwrite imported progress', () => {
    const store = open();
    const before = { ...sample(), version: store.historyData.version(episode().locator) };
    store.saveHistory(before);
    const backup = store.export();
    const restored = store.restore(backup);
    expect(restored.boundary.all).toBeGreaterThan(before.version.all);
    expect(() =>
      store.saveHistory({ ...before, position: 18, capturedAt: '2026-09-26T00:00:00.000Z' }),
    ).toThrow();
    expect(store.history()[0].position).toBe(9);
    expect(JSON.stringify(store.export().history)).not.toContain('"version"');
  });
  it('keeps completed and explicitly incomplete states through backup round trips', () => {
    const store = open();
    store.saveHistory({ ...sample(), completed: true });
    store.saveHistory({ ...sample(2), position: 24, completed: false });
    store.restore(store.export());
    expect(store.historyByKey(episodeKey(episode().locator))?.completed).toBe(true);
    expect(store.historyByKey(episodeKey(episode(2).locator))?.completed).toBe(false);
  });
});

describe('indexed history access and migration', () => {
  it('preserves v1 data and backs up before creating version fences and source indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sardina-history-migration-'));
    dirs.push(dir);
    const path = join(dir, 'profile.sqlite');
    const old = new Store(
      path,
      migrations.filter((m) => m.version === 1),
    );
    const entry = { ...sample(), key: episodeKey(episode().locator), updatedAt: sample().capturedAt };
    old.db
      .prepare('INSERT INTO history(key,updated_at,data) VALUES (?,?,?)')
      .run(entry.key, entry.updatedAt, JSON.stringify(entry));
    old.close();
    const upgraded = new Store(path);
    stores.push(upgraded);
    expect(upgraded.historyData.related([card])).toEqual([entry]);
    expect(upgraded.historyData.version(episode().locator)).toEqual({ profile: expect.any(String), all: 0, series: 0, episode: 0 });
    expect(existsSync(path + '.before-migration')).toBe(true);
  });
  it('paginates more than 1000 entries without duplicates, including equal timestamps', () => {
    const store = open();
    for (let i = 1; i <= 1205; i++) store.saveHistory(sample(i));
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = store.historyData.page({ limit: 100, cursor });
      expect(page.total).toBe(1205);
      keys.push(...page.items.map((entry) => entry.key));
      cursor = page.nextCursor;
    } while (cursor);
    expect(keys).toHaveLength(1205);
    expect(new Set(keys).size).toBe(1205);
    expect(store.historyData.related([card])).toHaveLength(1205);
  });
  it('treats search metacharacters literally and rejects malformed cursors', () => {
    const store = open();
    store.saveHistory({ ...sample(), card: { ...card, title: '100% 的故事' } });
    store.saveHistory(sample(2));
    expect(store.historyData.page({ query: '%' }).total).toBe(1);
    expect(() => store.historyData.page({ cursor: 'not-json' })).toThrow('分页位置无效');
  });
});

it('exposes versioned history and rejects stale HTTP saves without changing authentication', async () => {
  const server = await createServer({
    database: ':memory:',
    token: 'history-test',
    sources: [fakeSource()],
    updates: false,
  });
  const headers = { host: '127.0.0.1', authorization: 'Bearer history-test' };
  try {
    const path = '/api/v1/history/entry?' + new URLSearchParams({ ...episode().locator });
    expect((await server.app.inject({ url: path, headers: { host: '127.0.0.1' } })).statusCode).toBe(401);
    const context = (await server.app.inject({ url: path, headers })).json();
    const write = { ...sample(), version: context.version };
    expect(
      (await server.app.inject({ method: 'POST', url: '/api/v1/history', headers, payload: write }))
        .statusCode,
    ).toBe(200);
    const deleted = (await server.app.inject({ method: 'DELETE', url: '/api/v1/history', headers })).json();
    expect(deleted.boundary.all).toBe(1);
    const stale = await server.app.inject({
      method: 'POST',
      url: '/api/v1/history',
      headers,
      payload: write,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('HISTORY_CHANGED');
    expect((await server.app.inject({ url: '/api/v1/history/page', headers })).json()).toMatchObject({
      items: [],
      total: 0,
    });
  } finally {
    await server.app.close();
  }
});
