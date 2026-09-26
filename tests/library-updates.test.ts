import { afterEach, describe, expect, it, vi } from 'vitest';
import { episodeSnapshot, pendingUpdateCount, withEpisodeSnapshots } from '../packages/core/src/library';
import type { SourceDetail } from '../packages/core/src/types';
import { Registry } from '../packages/engine/src/registry';
import { Store } from '../packages/engine/src/store';
import { createServer } from '../packages/engine/src/server';
import { card, detail, episode, fakeSource } from './helpers';

const stores: Store[] = [],
  registries: Registry[] = [];
const open = () => {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
};
const registry = (store: Store, sources = [fakeSource()]) => {
  const value = new Registry(store, sources);
  registries.push(value);
  return value;
};
const at = '2026-09-26T00:00:00.000Z';
const nextAt = '2026-09-26T01:00:00.000Z';
const edition = (numbers: number[], patch: Partial<SourceDetail> = {}): SourceDetail => ({
  ...card,
  lines: [{ id: 'mp4', name: 'MP4', episodes: numbers.map((number) => episode(number)) }],
  ...patch,
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of registries.splice(0)) item.close();
  for (const store of stores.splice(0)) if (store.db.open) store.close();
});

describe('concrete update reminders', () => {
  it('deduplicates equivalent lines, identifies replacements at the same count, and preserves specials', () => {
    const store = open();
    const initial = store.addLibrary(card, 'watching');
    const baseline = withEpisodeSnapshots(initial, [episodeSnapshot(detail, at)]);
    expect(baseline.latestCount).toBe(3);
    expect(pendingUpdateCount(baseline)).toBe(0);
    const changed = edition([1, 3, 12.5]);
    changed.lines[0].episodes[2].kind = 'special';
    const result = withEpisodeSnapshots(baseline, [episodeSnapshot(changed, nextAt)]);
    expect(result.updates?.map((entry) => [entry.number, entry.kind])).toEqual([
      [3, 'episode'],
      [12.5, 'special'],
    ]);
    expect(result.contentUpdatedAt).toBe(nextAt);
    expect(withEpisodeSnapshots(result, [episodeSnapshot(changed, nextAt)]).updates).toHaveLength(2);
  });
  it('keeps count-only legacy reminders until explicit acknowledgement and retains new episode identities', () => {
    const store = open();
    let entry = store.addLibrary(card, 'watching');
    entry = { ...entry, latestCount: 3, seenCount: 1, checkedAt: at };
    entry = withEpisodeSnapshots(entry, [episodeSnapshot(edition([1, 2, 3]), at)]);
    expect(pendingUpdateCount(entry)).toBe(2);
    entry = store.saveLibrary(withEpisodeSnapshots(entry, [episodeSnapshot(edition([1, 2, 3, 4]), nextAt)]));
    expect(pendingUpdateCount(entry)).toBe(3);
    expect(entry.updates?.map((episode) => episode.number)).toEqual([4]);
    expect(() => store.updateLibrary(entry.id, { markSeen: true, revision: 'outdated' })).toThrow('已变化');
    const seen = store.updateLibrary(entry.id, { markSeen: true, revision: entry.revision });
    expect(pendingUpdateCount(seen)).toBe(0);
    expect(seen.contentUpdatedAt).toBe(nextAt);
  });
  it('bounds request concurrency, reports failures, and refreshes card snapshots', async () => {
    const store = open();
    for (let i = 0; i < 7; i++)
      store.addLibrary({ ...card, id: String(i), title: `Series ${i}` }, 'watching');
    let active = 0,
      peak = 0;
    const source = fakeSource('fixture', {
      getDetail: async (ref) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (ref.id === '2') throw new Error('offline');
        return {
          ...edition([1, 2]),
          id: ref.id,
          title: `Updated ${ref.id}`,
          remarks: '更新至 2 话',
          lines: [],
        };
      },
    });
    const engine = registry(store, [source]);
    expect(engine.startLibraryCheck()).toMatchObject({ running: true, total: 7 });
    await engine.checkLibrary();
    expect(peak).toBe(3);
    expect(engine.libraryCheckStatus()).toMatchObject({
      running: false,
      completed: 7,
      succeeded: 6,
      failed: 1,
      skipped: 0,
    });
    expect(store.library().find((entry) => entry.card.id === '0')?.card).toMatchObject({
      title: 'Updated 0',
      remarks: '更新至 2 话',
    });
    expect(store.library().find((entry) => entry.card.id === '2')?.updateError).toBeTruthy();
  });
  it('ignores delayed metadata after restore even if IDs and refs are identical', async () => {
    const store = open();
    const entry = store.addLibrary(card, 'watching');
    const backup = store.export();
    let release!: (detail: SourceDetail) => void;
    let ready!: () => void;
    const began = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const engine = registry(store, [
      fakeSource('fixture', {
        getDetail: async () => {
          ready();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      }),
    ]);
    const checking = engine.checkLibrary();
    await began;
    store.restore(backup);
    release(edition([1, 2, 3, 4], { title: 'Must not overwrite restored data' }));
    await checking;
    expect(store.getLibrary(entry.id)).toMatchObject({ latestCount: 0, card: { title: card.title } });
    expect(engine.libraryCheckStatus()).toMatchObject({ skipped: 1, succeeded: 0 });
  });
  it('ignores delayed results after changing references and preserves status edits with stable refs', async () => {
    const store = open();
    const entry = store.addLibrary(card, 'watching');
    const engine = registry(store, [
      fakeSource('fixture', {
        getDetail: async () => {
          store.updateLibrary(entry.id, { ref: { sourceId: 'other', id: 'two' } });
          return edition([1, 2, 3]);
        },
      }),
    ]);
    await engine.checkLibrary();
    expect(store.getLibrary(entry.id).latestCount).toBe(0);
    expect(engine.libraryCheckStatus()?.skipped).toBe(1);
    const second = registry(store, [
      fakeSource('fixture', {
        getDetail: async () => {
          store.updateLibrary(entry.id, { status: 'paused' });
          return edition([1, 2]);
        },
      }),
    ]);
    await second.checkLibrary(entry.id);
    expect(store.getLibrary(entry.id)).toMatchObject({ status: 'paused', latestCount: 2 });
  });
  it('cancels an obsolete job and accepts a fresh check immediately after restore', async () => {
    const store = open();
    store.addLibrary(card, 'watching');
    const backup = store.export();
    let ready!: () => void;
    const began = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let first = true;
    const engine = registry(store, [
      fakeSource('fixture', {
        getDetail: async () => {
          if (first) {
            first = false;
            ready();
            return new Promise(() => {});
          }
          return detail;
        },
      }),
    ]);
    const obsolete = engine.checkLibrary();
    const outcome = Promise.allSettled([obsolete]);
    await began;
    store.restore(backup);
    engine.clearCache();
    await engine.checkLibrary();
    expect((await outcome)[0].status).toBe('rejected');
    expect(engine.libraryCheckStatus()).toMatchObject({ running: false, succeeded: 1 });
    expect(store.library()[0].latestCount).toBe(3);
  });
  it('retains successful source updates when another associated source fails', async () => {
    const store = open();
    const entry = store.addLibrary(card, 'watching');
    store.updateLibrary(entry.id, { ref: { sourceId: 'other', id: 'one' } });
    const engine = registry(store, [
      fakeSource(),
      fakeSource('other', {
        getDetail: async () => {
          throw new Error('offline');
        },
      }),
    ]);
    await engine.checkLibrary();
    expect(store.getLibrary(entry.id)).toMatchObject({
      latestCount: 3,
      checkedAt: expect.any(String),
      updateError: expect.any(String),
    });
    expect(engine.libraryCheckStatus()).toMatchObject({ failed: 1, succeeded: 0 });
  });
  it('does not apply a result after a source was unlinked and re-linked during the request', async () => {
    const store = open();
    const entry = store.addLibrary(card, 'watching');
    store.updateLibrary(entry.id, { ref: { sourceId: 'other', id: 'one' } });
    const engine = registry(store, [
      fakeSource('fixture', {
        getDetail: async () => {
          store.updateLibrary(entry.id, { unlinkRef: { sourceId: 'other', id: 'one' } });
          store.updateLibrary(entry.id, { ref: { sourceId: 'other', id: 'one' } });
          return detail;
        },
      }),
    ]);
    await engine.checkLibrary();
    expect(engine.libraryCheckStatus()?.skipped).toBe(1);
    expect(store.getLibrary(entry.id).episodeSnapshots).toEqual([]);
  });
});

describe('confirmed association and reversible deletion', () => {
  const a = { ...card, season: undefined };
  const b = { ...card, sourceId: 'other', id: 'two', season: undefined };
  it('keeps ordinary favorites separate even when their full edition metadata matches', () => {
    const store = open();
    const target = { ...card, sourceId: 'other', id: 'two' };
    const first = store.addLibrary(card, 'watching');
    const second = store.addLibrary(target, 'planned');
    expect(first.id).not.toBe(second.id);
    expect(store.library()).toHaveLength(2);
    expect(store.addLibrary(card, 'paused').id).toBe(first.id);
    expect(store.getLibrary(second.id).status).toBe('planned');
    const preview = store.previewLibraryLink({ card, target });
    expect(preview.merged.map((entry) => entry.id)).toEqual([second.id]);
    expect(store.library()).toHaveLength(2);
    expect(store.confirmLibraryLink(preview.token).refs).toHaveLength(2);
    expect(store.library()).toHaveLength(1);
  });
  it('does not mutate while previewing and atomically creates or merges on confirmation', () => {
    const store = open();
    const preview = store.previewLibraryLink({ card: a, target: b });
    expect(preview).toMatchObject({ creates: true, base: null, merged: [] });
    expect(store.library()).toEqual([]);
    const saved = store.confirmLibraryLink(preview.token);
    expect(saved.refs).toHaveLength(2);
    expect(store.library()).toHaveLength(1);
    expect(() => store.confirmLibraryLink(preview.token)).toThrow('已过期');
  });
  it('shows merge side effects and rejects a changed preview without partial writes', () => {
    const store = open();
    const first = store.addLibrary(a, 'watching'),
      second = store.addLibrary(b, 'planned');
    const preview = store.previewLibraryLink({ card: a, target: b, libraryId: first.id });
    expect(preview.merged.map((entry) => entry.id)).toEqual([second.id]);
    expect(preview.status).toBe('watching');
    store.updateLibrary(second.id, { status: 'paused' });
    expect(() => store.confirmLibraryLink(preview.token)).toThrow('重新预览');
    expect(store.library()).toHaveLength(2);
    const fresh = store.previewLibraryLink({ card: a, target: b });
    const merged = store.confirmLibraryLink(fresh.token);
    expect(store.library()).toHaveLength(1);
    expect(merged.status).toBe('watching');
    expect(store.updateLibrary(merged.id, { unlinkRef: b, revision: merged.revision }).refs).toEqual([
      { sourceId: a.sourceId, id: a.id },
    ]);
    expect(() => store.updateLibrary(merged.id, { unlinkRef: a })).toThrow('主来源');
  });
  it('restores removed associations and refuses to overwrite later changes or restored profiles', () => {
    const store = open();
    const linked = store.confirmLibraryLink(store.previewLibraryLink({ card: a, target: b }).token);
    const removed = store.removeLibraryWithUndo(linked.id);
    const restored = store.undoLibrary(removed.undoToken);
    expect(restored.refs).toEqual(linked.refs);
    expect(restored.revision).not.toBe(linked.revision);
    const second = store.removeLibraryWithUndo(linked.id);
    const newer = store.addLibrary(b, 'paused');
    store.removeLibrary(newer.id);
    expect(() => store.undoLibrary(second.undoToken)).toThrow('不会覆盖');
    const saved = store.addLibrary(a, 'watching');
    const backup = store.export();
    const last = store.removeLibraryWithUndo(saved.id);
    store.restore(backup);
    expect(() => store.undoLibrary(last.undoToken)).toThrow('撤销时间');
  });
  it('rolls back every deleted collection if a confirmed merge cannot be saved', () => {
    const store = open();
    const first = store.addLibrary(a, 'watching'),
      second = store.addLibrary(b, 'planned');
    const preview = store.previewLibraryLink({ card: a, target: b });
    vi.spyOn(store, 'saveLibrary').mockImplementationOnce(() => {
      throw new Error('disk failure');
    });
    expect(() => store.confirmLibraryLink(preview.token)).toThrow('disk failure');
    expect(store.getLibrary(first.id).refs).toHaveLength(1);
    expect(store.getLibrary(second.id).refs).toHaveLength(1);
  });
  it('expires pending confirmations and deletion undo without silently overwriting new data', () => {
    const store = open();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const entry = store.addLibrary(a, 'watching');
    const removed = store.removeLibraryWithUndo(entry.id);
    const preview = store.previewLibraryLink({ card: a, target: b });
    vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
    expect(() => store.undoLibrary(removed.undoToken)).toThrow('撤销时间');
    expect(() => store.confirmLibraryLink(preview.token)).toThrow('已过期');
    expect(store.library()).toEqual([]);
  });
  it('supports preview, confirmation, job status, and undo through the authenticated API', async () => {
    const server = await createServer({
      database: ':memory:',
      token: 'library-tests',
      updates: false,
      sources: [fakeSource(), fakeSource('other')],
    });
    const headers = { host: '127.0.0.1', authorization: 'Bearer library-tests' };
    try {
      const preview = await server.app.inject({
        method: 'POST',
        url: '/api/v1/library/link/preview',
        headers,
        payload: { card: a, target: b },
      });
      expect(preview.statusCode).toBe(200);
      expect(server.store.library()).toEqual([]);
      const confirmed = await server.app.inject({
        method: 'POST',
        url: '/api/v1/library/link',
        headers,
        payload: { token: preview.json().token },
      });
      expect(confirmed.json().refs).toHaveLength(2);
      const removed = await server.app.inject({
        method: 'DELETE',
        url: `/api/v1/library/${confirmed.json().id}`,
        headers,
      });
      const undone = await server.app.inject({
        method: 'POST',
        url: '/api/v1/library/undo',
        headers,
        payload: { token: removed.json().undoToken },
      });
      expect(undone.statusCode).toBe(200);
      const started = await server.app.inject({
        method: 'POST',
        url: '/api/v1/library/check/start',
        headers,
        payload: { id: undone.json().id },
      });
      expect(started.statusCode).toBe(200);
      await server.registry.checkLibrary();
      const status = await server.app.inject({ url: '/api/v1/library/check/status', headers });
      expect(status.json()).toMatchObject({ completed: 1, running: false });
    } finally {
      await server.app.close();
    }
  });
});
