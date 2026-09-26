import { historyTime } from '../../../packages/core/src/progress';
import { pendingUpdateCount } from '../../../packages/core/src/library';
import {
  refKey,
  type HistoryEntry,
  type LibraryEntry,
  type SourceRef,
  type WatchStatus,
} from '../../../packages/core/src/types';

export const LIBRARY_PAGE_SIZE = 48;
export const LIBRARY_BATCH_LIMIT = 50;
export type LibrarySort = 'watched' | 'updated' | 'added' | 'title';
export interface LibraryFilters {
  query: string;
  status: WatchStatus | 'all';
  updatesOnly: boolean;
  sort: LibrarySort;
}

export function latestForLibrary(history: HistoryEntry[], library: LibraryEntry[]) {
  const groups = new Map<string, string>();
  for (const entry of library) for (const ref of entry.refs) groups.set(refKey(ref), entry.id);
  const result = new Map<string, HistoryEntry>();
  for (const item of history) {
    const id = groups.get(refKey(item.card));
    if (id && (!result.has(id) || historyTime(item) > historyTime(result.get(id)!))) result.set(id, item);
  }
  return result;
}

export function filterLibrary(
  library: LibraryEntry[],
  filters: LibraryFilters,
  latest: Map<string, HistoryEntry>,
) {
  const query = filters.query.trim().normalize('NFKC').toLocaleLowerCase();
  return library
    .filter(
      (entry) =>
        (filters.status === 'all' || entry.status === filters.status) &&
        (!filters.updatesOnly || pendingUpdateCount(entry) > 0) &&
        (!query || entry.card.title.normalize('NFKC').toLocaleLowerCase().includes(query)),
    )
    .sort((a, b) => {
      if (filters.sort === 'title')
        return a.card.title.localeCompare(b.card.title, 'zh-CN') || a.id.localeCompare(b.id);
      const stamp = (entry: LibraryEntry) =>
        filters.sort === 'watched'
          ? latest.has(entry.id)
            ? historyTime(latest.get(entry.id)!)
            : 0
          : filters.sort === 'updated'
            ? entry.contentUpdatedAt
              ? Date.parse(entry.contentUpdatedAt)
              : 0
            : Date.parse(entry.addedAt);
      return (
        stamp(b) - stamp(a) || a.card.title.localeCompare(b.card.title, 'zh-CN') || a.id.localeCompare(b.id)
      );
    });
}

export interface HistoryGroup {
  id: string;
  card: HistoryEntry['card'];
  refs: SourceRef[];
  entries: HistoryEntry[];
}
/** Only explicit library associations can join history from different sources. */
export function groupHistory(history: HistoryEntry[], library: LibraryEntry[]): HistoryGroup[] {
  const associated = new Map<string, LibraryEntry>();
  for (const entry of library) for (const ref of entry.refs) associated.set(refKey(ref), entry);
  const groups = new Map<string, HistoryGroup>();
  const seen = new Set<string>();
  for (const entry of [...history].sort((a, b) => historyTime(b) - historyTime(a))) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    const matched = associated.get(refKey(entry.card));
    const id = matched
      ? `library:${matched.id}`
      : `source:${JSON.stringify([entry.card.sourceId, entry.card.id])}`;
    const group = groups.get(id) ?? {
      id,
      card: matched?.card ?? entry.card,
      refs: matched?.refs ?? [{ sourceId: entry.card.sourceId, id: entry.card.id }],
      entries: [],
    };
    group.entries.push(entry);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function dateTime(value?: string) {
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚未检查';
}
