import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_MAX_BYTES } from '../packages/core/src/types';
import { createServer } from '../packages/engine/src/server';
import { Store } from '../packages/engine/src/store';
import { card, episode, fakeSource } from './helpers';

const dirs: string[] = [],
  stores: Store[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sardina-backup-recovery-'));
  dirs.push(dir);
  return dir;
};
const open = () => {
  const store = new Store(join(directory(), 'profile.sqlite'));
  stores.push(store);
  return store;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('automatic backup recovery', () => {
  it('previews replacement contents without writes and can recover the state before replacement', () => {
    const store = open();
    const entry = store.addLibrary(card, 'planned');
    const imported = store.export();
    store.updateLibrary(entry.id, { status: 'watching' });
    store.saveHistory({
      card,
      episode: episode(),
      capturedAt: new Date().toISOString(),
      position: 42,
      duration: 120,
    });
    const before = store.export();
    expect(store.previewBackup(imported)).toMatchObject({
      libraryCount: 1,
      historyCount: 0,
      current: { libraryCount: 1, historyCount: 1 },
      fingerprint: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    expect(store.export().library).toEqual(before.library);
    expect(store.backups.list().items).toEqual([]);
    const replaced = store.restore(imported);
    expect(store.library()[0].status).toBe('planned');
    const list = store.backups.list();
    expect(list.directory).toBe(store.backups.directory);
    expect(list.items[0]).toMatchObject({
      name: replaced.backupName,
      valid: true,
      libraryCount: 1,
      historyCount: 1,
    });
    const recovered = store.restore(store.backups.read(replaced.backupName!).data);
    expect(store.library()[0].status).toBe('watching');
    expect(store.history()[0].position).toBe(42);
    expect(recovered.boundary.all).toBeGreaterThan(replaced.boundary.all!);
    expect(store.backups.list().items).toHaveLength(2);
  });
  it('never overwrites automatic files when two restores happen in the same millisecond', () => {
    const store = open();
    const backup = store.export();
    vi.spyOn(Date, 'now').mockReturnValue(1234567890123);
    const first = store.restore(backup),
      second = store.restore(backup);
    expect(first.backupName).not.toBe(second.backupName);
    expect(readdirSync(store.backups.directory!)).toHaveLength(2);
  });
  it('rejects traversal, malformed files, oversized files, and file symlinks without changing the profile', () => {
    const store = open();
    store.addLibrary(card, 'watching');
    const initial = store.export();
    store.restore(initial);
    const dir = store.backups.directory!;
    const external = join(directory(), 'external.json');
    writeFileSync(external, JSON.stringify(initial));
    writeFileSync(join(dir, 'before-restore-1.json'), '{bad json');
    symlinkSync(external, join(dir, 'before-restore-2.json'));
    mkdirSync(join(dir, 'before-restore-3.json'));
    const huge = openSync(join(dir, 'before-restore-4.json'), 'w');
    ftruncateSync(huge, BACKUP_MAX_BYTES + 1);
    closeSync(huge);
    for (const name of [
      '../external.json',
      '/tmp/external.json',
      'before-restore-1.json',
      'before-restore-2.json',
      'before-restore-3.json',
      'before-restore-4.json',
    ])
      expect(() => store.backups.read(name)).toThrow();
    expect(store.backups.list().items.some((item) => item.name === 'before-restore-2.json')).toBe(false);
    expect(store.backups.list().items.find((item) => item.name === 'before-restore-1.json')).toMatchObject({
      valid: false,
    });
    expect(store.library()[0].status).toBe('watching');
    expect(JSON.parse(readFileSync(external, 'utf8'))).toEqual(initial);
  });
  it('rejects a symlinked backup directory before writing or restoring', () => {
    const store = open();
    const external = directory();
    symlinkSync(external, store.backups.directory!);
    store.addLibrary(card, 'watching');
    const backup = { ...store.export(), library: [] };
    expect(() => store.restore(backup)).toThrow('实际文件夹');
    expect(() => store.backups.list()).toThrow('实际文件夹');
    expect(store.library()).toHaveLength(1);
    expect(readdirSync(external)).toEqual([]);
  });
  it('uses identical validation for preview and restore, including new per-source episode data', () => {
    const store = open();
    store.addLibrary(card, 'watching');
    const backup = store.export();
    const invalid = {
      ...backup,
      library: [
        {
          ...backup.library[0],
          updates: [
            { ...episode(), sourceId: 'wrong', id: card.id, key: 'wrong', addedAt: backup.exportedAt },
          ],
        },
      ],
    };
    expect(() => store.previewBackup(invalid)).toThrow();
    expect(() => store.restore(invalid)).toThrow();
    expect(store.backups.list().items).toEqual([]);
    expect(store.export().library).toEqual(backup.library);
  });
  it('exposes download/preview/restore endpoints and rejects changed file fingerprints', async () => {
    const server = await createServer({
      database: join(directory(), 'profile.sqlite'),
      token: 'backup-recovery',
      updates: false,
      sources: [fakeSource()],
    });
    const headers = { host: '127.0.0.1', authorization: 'Bearer backup-recovery' };
    try {
      const entry = server.store.addLibrary(card, 'planned');
      const imported = server.store.export();
      server.store.updateLibrary(entry.id, { status: 'watching' });
      const replace = await server.app.inject({
        method: 'POST',
        url: '/api/v1/backup/restore',
        headers,
        payload: imported,
      });
      expect(replace.statusCode).toBe(200);
      const name = replace.json().backupName;
      const path = `/api/v1/backup/files/${name}`;
      const preview = await server.app.inject({ method: 'POST', url: `${path}/preview`, headers });
      expect(preview.statusCode).toBe(200);
      const download = await server.app.inject({ url: path, headers });
      expect(download.headers['content-disposition']).toContain(name);
      const conflict = await server.app.inject({
        method: 'POST',
        url: `${path}/restore`,
        headers,
        payload: { fingerprint: 'f'.repeat(64) },
      });
      expect(conflict.statusCode).toBe(409);
      expect(server.store.library()[0].status).toBe('planned');
      const recovered = await server.app.inject({
        method: 'POST',
        url: `${path}/restore`,
        headers,
        payload: { fingerprint: preview.json().fingerprint },
      });
      expect(recovered.statusCode).toBe(200);
      expect(server.store.library()[0].status).toBe('watching');
      const list = await server.app.inject({ url: '/api/v1/backup/files', headers });
      expect(list.json().items).toHaveLength(2);
    } finally {
      await server.app.close();
    }
  });
});
