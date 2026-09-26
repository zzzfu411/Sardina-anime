import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AppSettings, SourceModule, SourceState } from '../../../packages/core/src/types';
import { api, onSettingsChanged, preferSettings } from './api';
import { useToast } from './ui';
import { SourcePreferences } from './source-preferences';

export type { SourceModule } from '../../../packages/core/src/types';
const stores = new WeakMap<QueryClient, SourcePreferences>();
const connections = new WeakMap<SourcePreferences, { count: number; release: () => void }>();
const prefix = 'sardina:source-preference:v1:';
const channel = 'sardina:source-preference-saved:v1';
const moduleLabels: Record<SourceModule, string> = {
  search: '搜索',
  home: '推荐',
  catalog: '索引',
  schedule: '放送',
};

export function selectModuleSource(
  sources: SourceState[],
  requested: string | null | undefined,
  remembered: string,
  avoid?: string,
) {
  // An explicit, unavailable source must not silently search somewhere else.
  if (requested) return sources.find((source) => source.id === requested);
  const candidates = sources.filter((source) => source.id !== avoid);
  const eligible = candidates.length ? candidates : sources;
  return eligible.find((source) => source.id === remembered) ?? eligible[0];
}

function cachedPreference(module: SourceModule) {
  try {
    return window.localStorage.getItem(prefix + module) ?? '';
  } catch {
    return '';
  }
}

function connect(preferences: SourcePreferences, client: QueryClient) {
  let connection = connections.get(preferences);
  if (!connection) {
    const retry = () => preferences.retry();
    const changed = (event: StorageEvent) => {
      if (event.key === channel) void client.invalidateQueries({ queryKey: ['settings'] });
    };
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    window.addEventListener('storage', changed);
    const stopSettings = onSettingsChanged((settings) => {
      void client.cancelQueries({ queryKey: ['settings'] });
      preferences.accept(settings);
      client.setQueryData<AppSettings>(['settings'], (current) => preferSettings(current, settings));
    });
    connection = {
      count: 0,
      release: () => {
        window.removeEventListener('online', retry);
        window.removeEventListener('focus', retry);
        window.removeEventListener('storage', changed);
        stopSettings();
      },
    };
    connections.set(preferences, connection);
  }
  connection.count++;
  return () => {
    if (--connection!.count === 0) {
      connection!.release();
      connections.delete(preferences);
    }
  };
}

/** The profile owns saved defaults; browser storage only supplies a hint while it is loading. */
export function useSourcePreference(module: SourceModule): [string, (id: string) => void, boolean] {
  const client = useQueryClient();
  const toast = useToast();
  let store = stores.get(client);
  if (!store) {
    store = new SourcePreferences({
      send: async (sourceModule, sourceId, generation) => {
        // Keep the initial read alive if a direct URL selects a source before settings have loaded.
        if (client.getQueryData(['settings'])) await client.cancelQueries({ queryKey: ['settings'] });
        return api<AppSettings>('/settings/source-preferences', {
          method: 'PATCH',
          body: JSON.stringify({ module: sourceModule, sourceId, generation }),
          signal: AbortSignal.timeout(10_000),
          keepalive: true,
        });
      },
      saved: (settings) => {
        client.setQueryData<AppSettings>(['settings'], (current) => preferSettings(current, settings));
        try {
          for (const [sourceModule, sourceId] of Object.entries(settings.sourcePreferences ?? {}))
            localStorage.setItem(prefix + sourceModule, sourceId);
          localStorage.setItem(
            channel,
            JSON.stringify({ revision: settings.revision, nonce: crypto.randomUUID() }),
          );
        } catch {
          /* The server profile is authoritative even when browser storage is unavailable. */
        }
      },
      failed: (sourceModule, error) =>
        toast(
          `当前${moduleLabels[sourceModule]}来源已切换，但默认选择未保存：${error instanceof Error ? error.message : '网络错误'}。联网或重新聚焦后会重试。`,
        ),
      invalidated: (refresh) => {
        toast('资料已恢复或切换，旧的来源选择已取消。');
        if (refresh)
          void (async () => {
            await client.cancelQueries({ queryKey: ['settings'] });
            try {
              const latest = await api<AppSettings>('/settings');
              store!.accept(latest);
              client.setQueryData<AppSettings>(['settings'], (current) => preferSettings(current, latest));
            } catch (error) {
              toast(`读取恢复后的设置失败：${error instanceof Error ? error.message : '请重新加载页面'}`);
            }
          })();
      },
    });
    const cached = client.getQueryData<AppSettings>(['settings']);
    if (cached) store.accept(cached);
    stores.set(client, store);
  }
  const preferences = store;
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api<AppSettings>('/settings', { signal }),
  });
  useEffect(() => {
    if (settings.data) preferences.accept(settings.data);
  }, [preferences, settings.data]);
  const preferred = useSyncExternalStore(
    preferences.subscribe,
    () => preferences.read(module, cachedPreference(module)),
    () => '',
  );
  const ready = useSyncExternalStore(
    preferences.subscribe,
    () => preferences.ready,
    () => false,
  );
  useEffect(() => connect(preferences, client), [client, preferences]);
  const remember = useCallback((id: string) => preferences.choose(module, id), [module, preferences]);
  return [preferred, remember, ready || settings.isError];
}
