import type { SearchPage } from '../../../packages/core/src/types';

export interface SearchMemoryResult {
  status: 'loading' | 'done' | 'error' | 'challenge' | 'cancelled';
  page?: SearchPage;
  message?: string;
  requestedPage?: number;
  requestedCursor?: string;
}
interface Snapshot {
  at: number;
  results: Record<string, SearchMemoryResult>;
  positions: Record<string, number>;
}
const CACHE_KEY = 'sardina:search-memory:v1';
const MAX_ENTRIES = 10;
const MAX_AGE = 30 * 60_000;
const MAX_PERSISTED_BYTES = 3 * 1024 * 1024;

/** Verification challenges belong to a released session and are never reused on return. */
export function completedSearchSnapshot(results: Record<string, SearchMemoryResult>) {
  const completed: Record<string, SearchMemoryResult> = {};
  for (const [sourceId, result] of Object.entries(results)) {
    if (!result.page) continue;
    completed[sourceId] = {
      page: result.page,
      requestedPage: result.requestedPage,
      requestedCursor: result.requestedCursor,
      status: result.status === 'loading' || result.status === 'challenge' ? 'cancelled' : result.status,
      message:
        result.status === 'loading' || result.status === 'challenge'
          ? '离开时后续搜索尚未完成，已保留加载过的结果。可继续加载或重试。'
          : result.message,
    };
  }
  return completed;
}

export class SearchMemory {
  private entries = new Map<string, Snapshot>();
  constructor(
    private storage?: Pick<Storage, 'getItem' | 'setItem'>,
    private now = Date.now,
  ) {
    try {
      const data: unknown = JSON.parse(storage?.getItem(CACHE_KEY) ?? '[]');
      if (!Array.isArray(data)) return;
      for (const [key, snapshot] of data.slice(-MAX_ENTRIES)) {
        if (typeof key === 'string' && this.valid(snapshot)) this.entries.set(key, snapshot);
      }
    } catch {
      /* Invalid or unavailable tab storage only loses cached browsing state. */
    }
  }
  private valid(value: unknown): value is Snapshot {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Snapshot;
    return (
      Number.isFinite(candidate.at) &&
      this.now() - candidate.at < MAX_AGE &&
      Boolean(
        candidate.results &&
        typeof candidate.results === 'object' &&
        candidate.positions &&
        typeof candidate.positions === 'object',
      ) &&
      Object.values(candidate.results).every(
        (result) =>
          result?.page &&
          Array.isArray(result.page.items) &&
          Number.isInteger(result.page.page) &&
          result.page.page > 0 &&
          result.page.items.every(
            (card) =>
              card &&
              typeof card.id === 'string' &&
              typeof card.sourceId === 'string' &&
              typeof card.title === 'string',
          ),
      )
    );
  }
  key(sourceId: string, keyword: string) {
    return JSON.stringify([sourceId, keyword.trim()]);
  }
  get(sourceId: string, keyword: string) {
    const key = this.key(sourceId, keyword);
    const item = this.entries.get(key);
    if (!item || !this.valid(item)) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, item);
    return item;
  }
  set(
    sourceId: string,
    keyword: string,
    results: Record<string, SearchMemoryResult>,
    location: string,
    scroll: number,
  ) {
    const key = this.key(sourceId, keyword);
    const old = this.entries.get(key);
    const positions = { ...old?.positions, [location]: Number.isFinite(scroll) ? Math.max(0, scroll) : 0 };
    const snapshot = {
      at: this.now(),
      results: completedSearchSnapshot(results),
      positions: Object.fromEntries(Object.entries(positions).slice(-20)),
    };
    this.entries.delete(key);
    if (Object.keys(snapshot.results).length) this.entries.set(key, snapshot);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    this.persist();
  }
  clear(sourceId: string, keyword: string) {
    this.entries.delete(this.key(sourceId, keyword));
    this.persist();
  }
  private persist() {
    if (!this.storage) return;
    const entries = [...this.entries];
    let encoded = JSON.stringify(entries);
    // Keep all pages in live memory; only older tab-reload snapshots yield to storage limits.
    while (encoded.length * 2 > MAX_PERSISTED_BYTES && entries.length) {
      entries.shift();
      encoded = JSON.stringify(entries);
    }
    try {
      this.storage.setItem(CACHE_KEY, encoded);
    } catch {
      /* In-memory back navigation remains available. */
    }
  }
}
