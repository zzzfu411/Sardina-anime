import { describe, expect, it, vi } from 'vitest';
import { ProgressQueue, PENDING_PREFIX } from '../apps/web/src/progress-queue';
import { episodeKey, type HistoryEntry, type HistoryWrite } from '../packages/core/src/types';
import { card, episode } from './helpers';
class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(n: number) {
    return [...this.data.keys()][n] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}
const write = (n = 1, position = 9): HistoryWrite => ({
  card,
  episode: episode(n),
  position,
  duration: 24,
  capturedAt: `2026-06-01T00:00:${String(position).padStart(2, '0')}.000Z`,
  version: { all: 0, series: 0, episode: 0 },
});
const saved = (input: HistoryWrite): HistoryEntry => ({
  ...input,
  key: episodeKey(input.episode.locator),
  updatedAt: input.capturedAt,
});
describe('durable and ordered playback saves', () => {
  it('does not publish a failed save and recovers its latest sample after a new queue is created', async () => {
    const storage = new MemoryStorage();
    const publish = vi.fn();
    const first = new ProgressQueue({
      storage,
      send: async () => {
        throw new Error('offline');
      },
      saved: publish,
    });
    first.enqueue(write());
    await first.flush();
    expect(publish).not.toHaveBeenCalled();
    expect(first.status(episodeKey(episode().locator))).toMatchObject({ phase: 'failed', durable: true });
    const recovered = new ProgressQueue({ storage, send: async (input) => saved(input), saved: publish });
    await recovered.flush();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ position: 9 }), expect.anything());
    expect(storage.length).toBe(0);
  });
  it('keeps a newer sample queued when an older request completes late', async () => {
    let resolve!: (entry: HistoryEntry) => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<HistoryEntry>((done) => {
            resolve = done;
          }),
      )
      .mockImplementation(async (input) => saved(input));
    const queue = new ProgressQueue({ storage: new MemoryStorage(), send, saved: vi.fn() });
    queue.enqueue(write());
    const pending = queue.flush();
    queue.enqueue(write(1, 12));
    resolve(saved(write()));
    await pending;
    expect(queue.size).toBe(1);
    await queue.flush();
    expect(send.mock.calls.at(-1)?.[0].position).toBe(12);
    expect(queue.size).toBe(0);
  });
  it('suppresses late acknowledgements after deletion and preserves fresh samples after its boundary', async () => {
    let resolve!: (entry: HistoryEntry) => void;
    const publish = vi.fn();
    const storage = new MemoryStorage();
    const queue = new ProgressQueue({
      storage,
      send: () =>
        new Promise((done) => {
          resolve = done;
        }),
      saved: publish,
    });
    queue.enqueue(write());
    const pending = queue.flush();
    queue.discard({}, { all: 1 });
    resolve(saved(write()));
    await pending;
    expect(publish).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
    expect(queue.enqueue(write())).toBe(false);
    const fresh = { ...write(1, 12), version: { all: 1, series: 0, episode: 0 } };
    queue.enqueue(fresh);
    queue.discard({}, { all: 1 });
    expect(queue.size).toBe(1);
    expect(queue.peek(episodeKey(episode().locator))).toEqual(fresh);
  });
  it('cannot remove a newer disk sample written by another window', async () => {
    let resolve!: (entry: HistoryEntry) => void;
    const storage = new MemoryStorage();
    const first = new ProgressQueue({
      storage,
      send: () =>
        new Promise((done) => {
          resolve = done;
        }),
      saved: vi.fn(),
    });
    first.enqueue(write());
    const pending = first.flush();
    const second = new ProgressQueue({ storage, send: async (input) => saved(input), saved: vi.fn() });
    second.enqueue(write(1, 12));
    resolve(saved(write()));
    await pending;
    expect(
      JSON.parse(storage.getItem(PENDING_PREFIX + encodeURIComponent(episodeKey(episode().locator)))!)
        .position,
    ).toBe(12);
    await second.flush();
    expect(storage.length).toBe(0);
  });
  it('discards stale server-rejected samples instead of retrying deleted progress forever', async () => {
    const storage = new MemoryStorage();
    const queue = new ProgressQueue({
      storage,
      send: async () => {
        throw Object.assign(new Error('changed'), { code: 'HISTORY_CHANGED' });
      },
      saved: vi.fn(),
    });
    queue.enqueue(write());
    await queue.flush();
    expect(queue.size).toBe(0);
    expect(storage.length).toBe(0);
    expect(queue.status(episodeKey(episode().locator)).phase).toBe('changed');
  });
  it('reports unavailable durable storage and bounds the in-memory backlog', async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('quota');
    };
    const queue = new ProgressQueue({
      storage,
      send: async () => {
        throw new Error('offline');
      },
      saved: vi.fn(),
    });
    queue.enqueue(write());
    await queue.flush();
    expect(queue.status(episodeKey(episode().locator))).toMatchObject({ phase: 'failed', durable: false });
    for (let n = 2; n <= 200; n++) expect(queue.enqueue(write(n))).toBe(true);
    expect(queue.enqueue(write(201))).toBe(false);
    expect(queue.size).toBe(200);
  });
  it('stops an unsampled player after deletion and ignores an older global notification', () => {
    const queue = new ProgressQueue({
      storage: new MemoryStorage(),
      send: async (input) => saved(input),
      saved: vi.fn(),
    });
    const key = episodeKey(episode().locator);
    queue.discard({}, { all: 1 });
    expect(queue.status(key, { all: 0, series: 0, episode: 0 }, card).phase).toBe('changed');
    queue.discard({ refs: [card] }, { series: [{ ...card, version: 1 }] });
    queue.discard({}, { all: 1 });
    expect(queue.status(key, { all: 1, series: 0, episode: 0 }, card).phase).toBe('changed');
    expect(queue.status(key, { all: 1, series: 1, episode: 0 }, card).phase).toBe('idle');
  });
  it('ignores corrupted durable samples with incomplete versions or mismatched references', () => {
    const storage = new MemoryStorage();
    storage.setItem(PENDING_PREFIX + 'bad-version', JSON.stringify({ ...write(), version: {} }));
    storage.setItem(
      PENDING_PREFIX + 'bad-card',
      JSON.stringify({ ...write(), card: { ...card, id: 'other' } }),
    );
    const queue = new ProgressQueue({ storage, send: async (input) => saved(input), saved: vi.fn() });
    expect(queue.size).toBe(0);
  });
  it('ignores a delayed scoped deletion from before a restore', () => {
    const queue = new ProgressQueue({
      storage: new MemoryStorage(),
      send: async (input) => saved(input),
      saved: vi.fn(),
    });
    const key = episodeKey(episode().locator);
    queue.discard({}, { epoch: 1, all: 1 });
    const fresh = { ...write(), version: { all: 1, series: 0, episode: 0 } };
    queue.enqueue(fresh);
    queue.discard({ key }, { epoch: 0, episode: { key, version: 1 } });
    expect(queue.peek(key)).toEqual(fresh);
    expect(queue.status(key, fresh.version, card).phase).toBe('pending');
  });
  it('protects a fresh window whose newer context predates its first deletion notification', () => {
    const queue = new ProgressQueue({
      storage: new MemoryStorage(),
      send: async (input) => saved(input),
      saved: vi.fn(),
    });
    const key = episodeKey(episode().locator);
    const fresh = { ...write(), version: { all: 2, series: 0, episode: 0 } };
    queue.enqueue(fresh);
    queue.discard({ key }, { epoch: 0, episode: { key, version: 1 } });
    expect(queue.peek(key)).toEqual(fresh);
    expect(queue.status(key, fresh.version, card).phase).toBe('pending');
    expect(queue.status('not-yet-sampled', fresh.version, card).phase).toBe('idle');
  });
});
