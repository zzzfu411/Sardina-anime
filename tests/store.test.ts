import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_MAX_BYTES } from '../packages/core/src/types';
import { Store, migrations } from '../packages/engine/src/store';
import { card, episode } from './helpers';
const capturedAt = '2026-06-01T08:00:00.000Z';
const dirs: string[] = [];
const stores: Store[] = [];
const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'revanime-test-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'test.sqlite'));
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('local data and migration guarantees', () => {
  it('restores progress and favorites across process-style reopen', () => {
    const store = open();
    const filename = store.filename;
    store.addLibrary(card, 'watching');
    store.linkBangumi(card, '42');
    store.saveHistory({ card, episode: episode(), position: 73.2, duration: 120, capturedAt });
    store.close();
    const reopened = new Store(filename);
    stores.push(reopened);
    expect(reopened.library()[0].status).toBe('watching');
    expect(reopened.history()[0].position).toBe(73.2);
    expect(reopened.bangumiLinks()).toEqual([{ sourceId: card.sourceId, id: card.id, subjectId: '42' }]);
  });
  it('backs up current data before transactional restore, including source preferences', () => {
    const store = open();
    store.addLibrary(card, 'planned');
    store.saveSourceSettings('fixture', false, 2);
    const backup = store.export();
    store.clearHistory();
    store.updateLibrary(store.library()[0].id, { status: 'completed' });
    store.saveSourceSettings('fixture', true, 0);
    const result = store.restore(backup);
    expect(readdirSync(join(store.filename, '..', 'backups'))).toContain(result.backupName);
    expect(store.library()[0].status).toBe('planned');
    expect(store.sourceSettings('fixture', 0)).toEqual({ enabled: false, priority: 2 });
    expect(JSON.stringify(backup)).not.toMatch(/cookie|sessionId|Authorization/);
  });
  it('leaves existing data untouched for corrupt or inconsistent backups', () => {
    const store = open();
    store.addLibrary(card, 'watching');
    const backup = store.export();
    expect(() => store.restore({ ...backup, version: 999 })).toThrow();
    expect(() =>
      store.restore({
        ...backup,
        library: [{ ...backup.library[0], refs: [{ sourceId: 'other', id: 'wrong' }] }],
      }),
    ).toThrow();
    expect(() =>
      store.restore({ ...backup, library: [...backup.library, { ...backup.library[0], id: 'other' }] }),
    ).toThrow();
    expect(store.export().library).toEqual(backup.library);
  });
  it('rolls back failed migrations and retains a pre-migration database', () => {
    const store = open();
    store.addLibrary(card, 'watching');
    const filename = store.filename;
    store.close();
    expect(
      () =>
        new Store(filename, [
          ...migrations,
          {
            version: Math.max(...migrations.map((m) => m.version)) + 1,
            sql: 'CREATE TABLE temp_test (id INTEGER); INVALID SQL;',
          },
        ]),
    ).toThrow();
    const reopened = new Store(filename);
    stores.push(reopened);
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(
      Math.max(...migrations.map((m) => m.version)),
    );
    expect(reopened.library()).toHaveLength(1);
    expect(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name = 'temp_test'").all()).toEqual([]);
    expect(readdirSync(join(filename, '..'))).toContain('test.sqlite.before-migration');
  });
  it('merges collections only on explicit association and preserves all references', () => {
    const store = open();
    const first = store.addLibrary({ ...card, season: undefined }, 'watching');
    const second = store.addLibrary({ ...card, sourceId: 'other', id: 'two', season: undefined }, 'planned');
    expect(store.library()).toHaveLength(2);
    store.updateLibrary(first.id, { ref: second.card });
    expect(store.library()).toHaveLength(1);
    expect(store.library()[0].refs).toHaveLength(2);
    expect(() =>
      store.saveHistory({
        card,
        episode: { ...episode(), locator: { ...episode().locator, animeId: 'mismatch' } },
        position: 10,
        duration: 20,
        capturedAt,
      }),
    ).toThrow();
  });
  it('replaces history only when the sample is newer', () => {
    const store = open();
    const older = '2026-06-01T08:00:00.000Z';
    const newer = '2026-06-01T08:00:01.000Z';
    const first = store.saveHistory({
      card,
      episode: episode(),
      position: 90,
      duration: 120,
      capturedAt: older,
    });
    const replaced = store.saveHistory({
      card,
      episode: episode(),
      position: 12,
      duration: 120,
      capturedAt: newer,
    });
    expect(replaced.position).toBe(12);
    expect(replaced.capturedAt).toBe(newer);
    expect(store.history()).toHaveLength(1);
    expect(store.historyByKey(first.key)?.position).toBe(12);
    const kept = store.saveHistory({
      card,
      episode: episode(),
      position: 1,
      duration: 120,
      capturedAt: older,
    });
    expect(kept.position).toBe(12);
    expect(kept.capturedAt).toBe(newer);
    expect(store.history()[0].position).toBe(12);
  });
  it('rejects stale settings writes and accepts the revision that was just saved', () => {
    const store = open();
    expect(store.settings().revision).toBe(0);
    const saved = store.saveSettings({ ...store.settings(), appearance: 'dark', revision: 0 });
    expect(saved.revision).toBe(1);
    expect(store.settings()).toMatchObject({ appearance: 'dark', revision: 1 });
    try {
      store.saveSettings({ ...saved, revision: 0, appearance: 'light' });
      throw new Error('expected SETTINGS_CONFLICT');
    } catch (error) {
      expect(error).toMatchObject({ code: 'SETTINGS_CONFLICT', status: 409 });
    }
    expect(store.settings()).toMatchObject({ appearance: 'dark', revision: 1 });
    expect(store.saveSettings(saved)).toMatchObject({ appearance: 'dark', revision: 2 });
  });
  it('rejects backups larger than BACKUP_MAX_BYTES', { timeout: 30_000 }, () => {
    const store = open();
    store.saveHistory({
      card: { ...card, description: 'x'.repeat(BACKUP_MAX_BYTES) },
      episode: episode(),
      position: 1,
      duration: 2,
      capturedAt,
    });
    try {
      store.export();
      throw new Error('expected BACKUP_TOO_LARGE');
    } catch (error) {
      expect(error).toMatchObject({ code: 'BACKUP_TOO_LARGE', status: 413 });
      expect((error as Error).message).toContain('64 MB');
    }
  });
  it('keeps settings revisions increasing across restoration of an older backup', () => {
    const store = open();
    const backup = store.export();
    const beforeRestore = store.saveSettings({ ...store.settings(), appearance: 'dark' });
    store.restore(backup);
    const restored = store.settings();
    expect(restored.appearance).toBe('light');
    expect(restored.revision).toBeGreaterThan(beforeRestore.revision!);
    expect(() => store.saveSettings(beforeRestore)).toThrow('资料已恢复');
    expect(() => store.saveSettings(backup.settings)).toThrow('设置已在另一个窗口更新');
  });
  it('compares history sample times with different ISO precision chronologically', () => {
    const store = open();
    store.saveHistory({
      card,
      episode: episode(),
      position: 90,
      duration: 120,
      capturedAt: '2026-06-01T08:00:00Z',
    });
    const newer = store.saveHistory({
      card,
      episode: episode(),
      position: 12,
      duration: 120,
      capturedAt: '2026-06-01T08:00:00.500Z',
    });
    expect(newer.position).toBe(12);
    expect(
      store.saveHistory({
        card,
        episode: episode(),
        position: 90,
        duration: 120,
        capturedAt: '2026-06-01T08:00:00Z',
      }).position,
    ).toBe(12);
  });
});
