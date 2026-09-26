import {
  episodeKey,
  refKey,
  type HistoryBoundary,
  type HistoryEntry,
  type HistoryVersion,
  type HistoryWrite,
  type SourceRef,
} from '../../../packages/core/src/types';

export type ProgressStatus = {
  phase: 'idle' | 'pending' | 'failed' | 'changed' | 'saved';
  durable: boolean;
  message?: string;
};
export type HistorySelection = { key?: string; refs?: SourceRef[] };
export const PENDING_PREFIX = 'sardina:pending-progress:v1:';
const IDLE: ProgressStatus = { phase: 'idle', durable: true };
const CHANGED: ProgressStatus = {
  phase: 'changed',
  durable: false,
  message: '观看记录已修改，请重新读取进度后继续。',
};
const LIMIT = 200;
const stamp = (write: HistoryWrite) => JSON.stringify([write.capturedAt, write.version]);
const versionEqual = (a?: HistoryVersion, b?: HistoryVersion) =>
  a?.profile === b?.profile && a?.all === b?.all && a?.series === b?.series && a?.episode === b?.episode;
const selected = (write: HistoryWrite, selection: HistorySelection) =>
  selection.key
    ? episodeKey(write.episode.locator) === selection.key
    : !selection.refs || selection.refs.some((ref) => refKey(ref) === refKey(write.card));

/** One latest sample per episode. Storage keys are per episode to avoid cross-window lost updates. */
export class ProgressQueue {
  private pending = new Map<string, HistoryWrite>();
  private known = new Map<string, HistoryWrite>();
  private states = new Map<string, ProgressStatus>();
  private listeners = new Set<() => void>();
  private running?: Promise<void>;
  private inFlight = new Map<string, Promise<void>>();
  private mutations = new Map<string, number>();
  private boundaryAll = 0;
  private boundarySeries = new Map<string, number>();
  private boundaryEpisodes = new Map<string, number>();
  constructor(
    private options: {
      storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
      send: (write: HistoryWrite) => Promise<HistoryEntry>;
      saved: (entry: HistoryEntry, write: HistoryWrite) => void;
    },
  ) {
    this.load();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private outdated(key: string, version?: HistoryVersion, ref?: SourceRef) {
    return (
      !!version &&
      version.all <= this.boundaryAll &&
      (version.all < this.boundaryAll ||
        version.episode < (this.boundaryEpisodes.get(key) ?? 0) ||
        (!!ref && version.series < (this.boundarySeries.get(refKey(ref)) ?? 0)))
    );
  }
  status(key: string, version?: HistoryVersion, ref?: SourceRef): ProgressStatus {
    const write = this.known.get(key);
    if (this.outdated(key, version, ref ?? write?.card)) return CHANGED;
    return write && (!version || versionEqual(write.version, version))
      ? (this.states.get(key) ?? IDLE)
      : IDLE;
  }
  private set(key: string, status: ProgressStatus) {
    this.states.set(key, status);
    for (const listener of this.listeners) listener();
  }
  private parse(raw: string | null): HistoryWrite | undefined {
    try {
      const value = JSON.parse(raw ?? 'null') as HistoryWrite;
      if (
        !value?.version ||
        typeof value.card?.id !== 'string' ||
        typeof value.card.sourceId !== 'string' ||
        typeof value.card.title !== 'string' ||
        typeof value.episode?.label !== 'string' ||
        !value.episode?.locator ||
        !['sourceId', 'animeId', 'lineId', 'episodeId'].every(
          (part) => typeof value.episode.locator[part as keyof typeof value.episode.locator] === 'string',
        ) ||
        value.card.id !== value.episode.locator.animeId ||
        value.card.sourceId !== value.episode.locator.sourceId ||
        !Number.isFinite(Date.parse(value.capturedAt)) ||
        !Number.isFinite(value.position) ||
        value.position < 0 ||
        !Number.isFinite(value.duration) ||
        value.duration < 0 ||
        !(['all', 'series', 'episode'] as const).every((part) => {
          const n = value.version![part];
          return Number.isSafeInteger(n) && n >= 0;
        }) ||
        (value.version.profile !== undefined && typeof value.version.profile !== 'string')
      )
        return;
      return value;
    } catch {
      return;
    }
  }
  private disk(key: string) {
    try {
      return this.parse(this.options.storage?.getItem(PENDING_PREFIX + encodeURIComponent(key)) ?? null);
    } catch {
      return;
    }
  }
  private remember(key: string, write: HistoryWrite) {
    this.known.delete(key);
    this.known.set(key, write);
    // Statuses of long-unmounted players must not accumulate forever.
    if (this.known.size > LIMIT * 2) {
      const oldest = [...this.known.keys()].find((item) => !this.pending.has(item));
      if (oldest) {
        this.known.delete(oldest);
        this.states.delete(oldest);
        if (!this.inFlight.has(oldest)) this.mutations.delete(oldest);
      }
    }
  }
  load() {
    const storage = this.options.storage;
    if (!storage) return;
    try {
      for (let index = 0; index < storage.length && this.pending.size < LIMIT; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(PENDING_PREFIX)) continue;
        const write = this.parse(storage.getItem(key));
        if (!write) continue;
        const id = episodeKey(write.episode.locator);
        const old = this.pending.get(id);
        if (!old || Date.parse(old.capturedAt) < Date.parse(write.capturedAt)) {
          this.pending.set(id, write);
          this.remember(id, write);
          this.set(id, { phase: 'pending', durable: true });
        }
      }
    } catch {
      /* A disabled store is reported when the next sample is enqueued. */
    }
  }
  enqueue(write: HistoryWrite): boolean {
    const key = episodeKey(write.episode.locator);
    if (this.outdated(key, write.version, write.card)) return false;
    const known = this.known.get(key);
    if (this.states.get(key)?.phase === 'changed' && versionEqual(known?.version, write.version))
      return false;
    if (!this.pending.has(key) && this.pending.size >= LIMIT) {
      this.remember(key, write);
      this.set(key, {
        phase: 'failed',
        durable: false,
        message: '待保存进度过多，请先重试保存，再继续观看。',
      });
      return false;
    }
    const old = this.pending.get(key) ?? this.disk(key);
    if (old && Date.parse(old.capturedAt) > Date.parse(write.capturedAt)) return true;
    this.pending.set(key, write);
    this.remember(key, write);
    let durable = false;
    try {
      if (this.options.storage) {
        this.options.storage.setItem(PENDING_PREFIX + encodeURIComponent(key), JSON.stringify(write));
        durable = true;
      }
    } catch {
      /* In-memory retry remains available; UI must not claim durable protection. */
    }
    this.set(key, { phase: 'pending', durable });
    return true;
  }
  private removeDisk(key: string, write: HistoryWrite) {
    if (stamp(this.disk(key) ?? ({ capturedAt: '' } as HistoryWrite)) !== stamp(write)) return;
    try {
      this.options.storage?.removeItem(PENDING_PREFIX + encodeURIComponent(key));
    } catch {
      /* retry is idempotent */
    }
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.load();
    this.running = this.sendPending().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async sendPending() {
    const keys = [...this.pending.keys()];
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, keys.length) }, async () => {
        while (index < keys.length) await this.flushKey(keys[index++]);
      }),
    );
  }
  flushKey(key: string): Promise<void> {
    const active = this.inFlight.get(key);
    if (active) return active;
    const write = this.pending.get(key);
    if (!write) return Promise.resolve();
    const task = (async () => {
      const mutation = this.mutations.get(key) ?? 0;
      try {
        const entry = await this.options.send(write);
        if (this.pending.get(key) === write) {
          this.pending.delete(key);
          this.removeDisk(key, write);
          if (mutation === (this.mutations.get(key) ?? 0) && !this.outdated(key, write.version, write.card))
            this.set(key, { phase: 'saved', durable: true });
        }
        if (mutation === (this.mutations.get(key) ?? 0) && !this.outdated(key, write.version, write.card))
          this.options.saved(entry, write);
      } catch (error) {
        if (this.pending.get(key) !== write) return;
        if ((error as { code?: string })?.code === 'HISTORY_CHANGED') {
          this.pending.delete(key);
          this.removeDisk(key, write);
          this.set(key, {
            phase: 'changed',
            durable: false,
            message: '观看记录已在其他页面修改，请重新读取进度后继续。',
          });
        } else
          this.set(key, {
            phase: 'failed',
            durable: stamp(this.disk(key) ?? ({ capturedAt: '' } as HistoryWrite)) === stamp(write),
            message: error instanceof Error ? error.message : '进度暂未保存',
          });
      }
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }
  discard(selection: HistorySelection = {}, boundary?: HistoryBoundary) {
    const epoch = boundary?.epoch ?? boundary?.all;
    if (epoch !== undefined && epoch < this.boundaryAll) return false;
    if (epoch !== undefined && epoch > this.boundaryAll) {
      this.boundaryAll = epoch;
      this.boundarySeries.clear();
      this.boundaryEpisodes.clear();
    }
    for (const ref of boundary?.series ?? [])
      this.boundarySeries.set(refKey(ref), Math.max(this.boundarySeries.get(refKey(ref)) ?? 0, ref.version));
    if (boundary?.episode)
      this.boundaryEpisodes.set(
        boundary.episode.key,
        Math.max(this.boundaryEpisodes.get(boundary.episode.key) ?? 0, boundary.episode.version),
      );
    this.load();
    const removed = (write: HistoryWrite) => {
      if (epoch !== undefined && write.version && write.version.all > epoch) return false;
      if (write.version && write.version.all < this.boundaryAll) return true;
      if (!selected(write, selection)) return false;
      if (!boundary) return true;
      if (boundary.all !== undefined) return (write.version?.all ?? -1) < boundary.all;
      if (boundary.episode) return (write.version?.episode ?? -1) < boundary.episode.version;
      const series = boundary.series?.find((ref) => refKey(ref) === refKey(write.card));
      return !!series && (write.version?.series ?? -1) < series.version;
    };
    for (const [key, write] of this.known) {
      if (!removed(write)) continue;
      this.mutations.set(key, (this.mutations.get(key) ?? 0) + 1);
      this.pending.delete(key);
      this.removeDisk(key, write);
      this.set(key, { phase: 'changed', durable: false, message: '观看记录已修改，请重新读取进度后继续。' });
    }
    // Remove matching disk records even when more than LIMIT were written by other windows.
    try {
      const storage = this.options.storage;
      if (storage)
        for (let index = storage.length - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (!key?.startsWith(PENDING_PREFIX)) continue;
          const write = this.parse(storage.getItem(key));
          if (write && removed(write)) storage.removeItem(key);
        }
    } catch {
      /* Server fences still reject all stale records. */
    }
    for (const listener of this.listeners) listener();
    return true;
  }
  get size() {
    return this.pending.size;
  }
  peek(key: string) {
    return this.pending.get(key);
  }
  latest(refs: SourceRef[]) {
    return [...this.pending.values()]
      .filter((write) => selected(write, { refs }))
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
  }
}
