import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/engine/src/store';
import { createServer } from '../packages/engine/src/server';
import { fakeSource } from './helpers';

const dirs: string[] = [],
  stores: Store[] = [];
const open = (filename = ':memory:') => {
  const store = new Store(filename);
  stores.push(store);
  return store;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('settings restore generation', () => {
  it('survives reopen, stays stable through normal writes, and is absent from portable backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sardina-settings-generation-'));
    dirs.push(dir);
    const filename = join(dir, 'profile.sqlite');
    const original = open(filename);
    const generation = original.settings().generation;
    expect(generation).toMatch(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
    const changed = original.saveSourcePreference('search', 'fixture', generation);
    expect(changed.generation).toBe(generation);
    expect(original.saveSettings({ ...changed, volume: 0.4 }).generation).toBe(generation);
    const portable = original.export();
    expect(portable.settings).not.toHaveProperty('generation');
    expect(JSON.stringify(portable)).not.toContain(generation!);
    const raw = original.db.prepare("SELECT data FROM settings WHERE key = 'app'").get() as { data: string };
    expect(JSON.parse(raw.data)).not.toHaveProperty('generation');
    original.close();
    const reopened = open(filename);
    expect(reopened.settings().generation).toBe(generation);
    const beforeRestoreRevision = reopened.settings().revision!;
    reopened.restore({
      ...portable,
      settings: { ...portable.settings, generation: 'untrusted-backup-value' },
    });
    expect(reopened.settings().generation).not.toBe(generation);
    expect(reopened.settings().generation).not.toBe('untrusted-backup-value');
    expect(reopened.settings().revision).toBeGreaterThan(beforeRestoreRevision);
  });
  it('rejects pre-restore PUT and source PATCH even if their revisions or values happen to match', () => {
    const store = open();
    const first = store.saveSourcePreference('search', 'fixture');
    const backup = store.export();
    store.saveSourcePreference('search', 'other', first.generation);
    store.restore(backup);
    const restored = store.settings();
    expect(() => store.saveSourcePreference('search', 'other', first.generation)).toThrow(
      expect.objectContaining({ code: 'SETTINGS_CHANGED', status: 409 }),
    );
    expect(() => store.saveSourcePreference('search', 'fixture', first.generation)).toThrow(
      expect.objectContaining({ code: 'SETTINGS_CHANGED', status: 409 }),
    );
    expect(() => store.saveSettings({ ...first, volume: 0.2 })).toThrow(
      expect.objectContaining({ code: 'SETTINGS_CHANGED', status: 409 }),
    );
    expect(() => store.saveSettings({ ...first, revision: restored.revision, volume: 0.2 })).toThrow(
      expect.objectContaining({ code: 'SETTINGS_CHANGED', status: 409 }),
    );
    expect(store.settings()).toEqual(restored);
    expect(store.saveSourcePreference('search', 'other', restored.generation).sourcePreferences?.search).toBe(
      'other',
    );
  });
  it('rolls back the generation and data together when restoration cannot commit', () => {
    const store = open();
    store.saveSourcePreference('search', 'fixture');
    const before = store.settings(),
      backup = store.export();
    vi.spyOn(store, 'saveSourceSettings').mockImplementation(() => {
      throw new Error('write failed');
    });
    expect(() =>
      store.restore({ ...backup, sourceSettings: [{ id: 'fixture', enabled: true, priority: 0 }] }),
    ).toThrow('write failed');
    expect(store.settings()).toEqual(before);
  });
  it('keeps old request and backup formats compatible without letting an input overwrite identity', () => {
    const store = open();
    const generation = store.settings().generation;
    const { generation: _omit, ...legacy } = store.settings();
    expect(store.saveSettings({ ...legacy, volume: 0.2 }).generation).toBe(generation);
    expect(store.saveSourcePreference('home', 'fixture').generation).toBe(generation);
    expect(() => store.saveSettings({ ...store.settings(), generation: 'forged' })).toThrow('资料已恢复');
    store.restore({ ...store.export(), settings: { autoNext: true, playbackRate: 1, volume: 0.8 } });
    expect(store.settings().sourcePreferences).toBeUndefined();
    expect(store.settings().generation).not.toBe(generation);
  });
  it('returns SETTINGS_CHANGED over the authenticated API for delayed PATCH and PUT after restore', async () => {
    const server = await createServer({
      database: ':memory:',
      token: 'generation-test',
      sources: [fakeSource(), fakeSource('other')],
      updates: false,
    });
    const headers = { host: '127.0.0.1', authorization: 'Bearer generation-test' };
    try {
      const original = (await server.app.inject({ url: '/api/v1/settings', headers })).json();
      const exported = (await server.app.inject({ url: '/api/v1/backup', headers })).json();
      expect(exported.settings).not.toHaveProperty('generation');
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/v1/backup/restore',
            headers,
            payload: exported,
          })
        ).statusCode,
      ).toBe(200);
      const patch = await server.app.inject({
        method: 'PATCH',
        url: '/api/v1/settings/source-preferences',
        headers,
        payload: { module: 'search', sourceId: 'other', generation: original.generation },
      });
      const put = await server.app.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers,
        payload: { ...original, volume: 0.1 },
      });
      for (const result of [patch, put]) {
        expect(result.statusCode).toBe(409);
        expect(result.json().code).toBe('SETTINGS_CHANGED');
      }
      expect(server.store.settings().volume).toBe(original.volume);
      expect(server.store.settings().sourcePreferences).toBeUndefined();
    } finally {
      await server.app.close();
    }
  });
});
