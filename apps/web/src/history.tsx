import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  episodeKey,
  refKey,
  type EpisodeLocator,
  type HistoryBoundary,
  type HistoryContext,
  type HistoryEntry,
  type HistoryVersion,
  type LibraryEntry,
  type SourceRef,
} from '../../../packages/core/src/types';
import { historyTime, relatedRefs } from '../../../packages/core/src/progress';
import { api, post } from './api';
import { PENDING_PREFIX, ProgressQueue, type HistorySelection } from './progress-queue';

const CHANNEL = 'sardina:history-change:v1';
const Context = createContext<ProgressQueue | null>(null);
const historyQuery = (query: { queryKey: readonly unknown[] }) =>
  ['history', 'history-recent', 'history-entry', 'anime-history', 'history-page'].includes(
    String(query.queryKey[0]),
  );
export const historyContextPath = (locator: EpisodeLocator) =>
  '/history/entry?' + new URLSearchParams({ ...locator });
const merge = (entries: HistoryEntry[] | undefined, entry: HistoryEntry) => {
  const existing = entries?.find((item) => item.key === entry.key);
  if (existing && historyTime(existing) > historyTime(entry)) return entries;
  return [entry, ...(entries ?? []).filter((item) => item.key !== entry.key)].sort(
    (a, b) => historyTime(b) - historyTime(a),
  );
};
function broadcast(change: object) {
  try {
    localStorage.setItem(CHANNEL, JSON.stringify({ ...change, nonce: crypto.randomUUID() }));
  } catch {
    /* same-window remains functional */
  }
}
async function clearHistoryCaches(client: QueryClient, selection: HistorySelection = {}) {
  await client.cancelQueries({ predicate: historyQuery });
  const selected = (entry: HistoryEntry) =>
    selection.key
      ? entry.key === selection.key
      : !selection.refs || selection.refs.some((ref) => refKey(ref) === refKey(entry.card));
  // Retain loaded contexts while clearing their record. Resetting an active query unmounted and
  // automatically restarted the player with a new version, bypassing its explicit reload prompt.
  for (const [key, data] of client.getQueriesData({ predicate: historyQuery })) {
    if (key[0] === 'history-entry' && data) {
      const context = data as HistoryContext;
      if (!selection.key || key[1] === selection.key)
        client.setQueryData(key, {
          ...context,
          entry: context.entry && selected(context.entry) ? null : context.entry,
        });
    } else if (Array.isArray(data))
      client.setQueryData(
        key,
        (data as HistoryEntry[]).filter((entry) => !selected(entry)),
      );
  }
  await Promise.all([
    client.resetQueries({ queryKey: ['history-page'] }),
    client.invalidateQueries({
      predicate: (query) => historyQuery(query) && query.queryKey[0] !== 'history-page',
    }),
  ]);
}
function savedProgress(client: QueryClient, entry: HistoryEntry, version?: HistoryVersion) {
  client.setQueryData<HistoryEntry[]>(['history'], (old) => (old ? merge(old, entry)?.slice(0, 1000) : old));
  client.setQueryData<HistoryEntry[]>(['history-recent'], (old) => {
    if (!old) return old;
    const previous = old?.find((item) => refKey(item.card) === refKey(entry.card));
    if (previous && historyTime(previous) > historyTime(entry)) return old;
    return merge(
      old?.filter((item) => refKey(item.card) !== refKey(entry.card)),
      entry,
    );
  });
  if (version)
    client.setQueryData<HistoryContext>(['history-entry', entry.key], (old) =>
      old?.entry && historyTime(old.entry) > historyTime(entry) ? old : { entry, version },
    );
  for (const [key] of client.getQueriesData({ queryKey: ['anime-history'] })) {
    const refs = key[1] as SourceRef[];
    if (refs?.some((ref) => refKey(ref) === refKey(entry.card)))
      client.setQueryData<HistoryEntry[]>(key, (old) => merge(old, entry));
  }
  void client.invalidateQueries({ queryKey: ['history-page'] });
}
export function HistoryProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [queue] = useState(() => {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* progress status reports persistence failure */
    }
    return new ProgressQueue({
      storage,
      send: (write) =>
        api<HistoryEntry>('/history', {
          method: 'POST',
          body: JSON.stringify(write),
          signal: AbortSignal.timeout(10_000),
        }),
      saved: (entry, write) => {
        savedProgress(client, entry, write.version);
        broadcast({ kind: 'saved' });
      },
    });
  });
  useEffect(() => {
    const retry = () => {
      void queue.flush();
    };
    const changed = (event: StorageEvent) => {
      if (event.key?.startsWith(PENDING_PREFIX)) retry();
      if (event.key !== CHANNEL || !event.newValue) return;
      try {
        const change = JSON.parse(event.newValue);
        if (change.kind === 'deleted' || change.kind === 'restored') {
          if (!queue.discard(change.selection ?? {}, change.boundary)) return;
          void clearHistoryCaches(client, change.selection ?? {});
          if (change.kind === 'restored') void client.invalidateQueries();
        } else void client.invalidateQueries({ predicate: historyQuery });
      } catch {
        /* Ignore invalid external storage content. */
      }
    };
    const refresh = () => {
      retry();
      void client.invalidateQueries({ predicate: historyQuery });
    };
    const timer = window.setInterval(retry, 5000);
    window.addEventListener('online', retry);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', changed);
    retry();
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', changed);
    };
  }, [client, queue]);
  return <Context.Provider value={queue}>{children}</Context.Provider>;
}
export function useProgressQueue() {
  const queue = useContext(Context);
  if (!queue) throw new Error('HistoryProvider is required');
  return queue;
}
export function useProgressStatus(key: string, version: HistoryVersion, ref?: SourceRef) {
  const queue = useProgressQueue();
  return useSyncExternalStore(queue.subscribe, () => queue.status(key, version, ref));
}
export function useAnimeHistory(ref: SourceRef, library: LibraryEntry[] = []) {
  const queue = useProgressQueue();
  const refs = relatedRefs(ref, library);
  return useQuery({
    queryKey: ['anime-history', refs],
    enabled: Boolean(ref.sourceId && ref.id),
    queryFn: async ({ signal }) => {
      const pending = queue.latest(refs);
      const key = pending ? episodeKey(pending.episode.locator) : '';
      if (key) await queue.flushKey(key);
      const entries = await api<HistoryEntry[]>('/history?refs=' + encodeURIComponent(JSON.stringify(refs)), {
        signal,
      });
      if (!pending || !queue.peek(key)) return entries;
      const context = await api<HistoryContext>(historyContextPath(pending.episode.locator), { signal });
      const protectedContext = pendingContext(queue, key, context);
      return protectedContext.entry ? merge(entries, protectedContext.entry)! : entries;
    },
  });
}
function pendingContext(queue: ProgressQueue, key: string, context: HistoryContext): HistoryContext {
  const pending = queue.peek(key);
  if (
    pending &&
    pending.version &&
    (Object.keys(context.version) as (keyof HistoryVersion)[]).every(
      (part) => pending.version![part] === context.version[part],
    ) &&
    (!context.entry || Date.parse(pending.capturedAt) > historyTime(context.entry))
  )
    return { ...context, entry: { ...pending, key, updatedAt: pending.capturedAt } as HistoryEntry };
  return context;
}
export function useHistoryContext(locator?: EpisodeLocator) {
  const queue = useProgressQueue();
  const key = locator ? episodeKey(locator) : '';
  return useQuery({
    queryKey: ['history-entry', key],
    enabled: Boolean(locator),
    queryFn: async ({ signal }) => {
      await queue.flushKey(key);
      const context = await api<HistoryContext>(historyContextPath(locator!), { signal });
      return pendingContext(queue, key, context);
    },
  });
}
export function useHistoryMutations() {
  const client = useQueryClient();
  const queue = useProgressQueue();
  const reset = async (selection: HistorySelection = {}, restored = false, boundary?: HistoryBoundary) => {
    if (!queue.discard(selection, boundary)) return;
    broadcast({ kind: restored ? 'restored' : 'deleted', selection, boundary });
    await clearHistoryCaches(client, selection);
  };
  return {
    restored: (boundary?: HistoryBoundary) => reset({}, true, boundary),
    remove: async (selection: HistorySelection = {}) => {
      const params = new URLSearchParams({
        ...(selection.key ? { key: selection.key } : {}),
        ...(selection.refs ? { refs: JSON.stringify(selection.refs) } : {}),
      });
      const result = await api<{ boundary: HistoryBoundary }>('/history?' + params, { method: 'DELETE' });
      await reset(selection, false, result.boundary);
    },
    complete: async (entry: HistoryEntry, completed: boolean, version: HistoryVersion) => {
      // Drain this episode's pending sample before a manual decision; it must not overwrite it later.
      await queue.flushKey(entry.key);
      const context = await api<HistoryContext>(historyContextPath(entry.episode.locator));
      if (
        Object.keys(version).some(
          (part) => version[part as keyof HistoryVersion] !== context.version[part as keyof HistoryVersion],
        )
      )
        throw new Error('观看记录已被删除或恢复，请重新读取后再标记');
      const capturedAt = new Date(
        Math.max(
          Date.now(),
          historyTime(context.entry ?? entry) + 1,
          Date.parse(queue.peek(entry.key)?.capturedAt ?? '1970-01-01') + 1,
        ),
      ).toISOString();
      const write = {
        ...(context.entry ?? entry),
        completed,
        position: completed ? (context.entry ?? entry).position : 0,
        capturedAt,
        version,
      };
      // Use the same queue so a failed manual save remains recoverable too.
      if (!queue.enqueue(write)) throw new Error('请先处理待保存的观看进度');
      await queue.flushKey(entry.key);
      if (queue.status(entry.key, context.version, entry.card).phase === 'changed')
        throw new Error('观看记录已变更，请重新读取');
      if (queue.peek(entry.key)) throw new Error('观看状态暂未保存，已保留，稍后会自动重试');
      // Only the queue's guarded acknowledgement may publish the result.
    },
  };
}
