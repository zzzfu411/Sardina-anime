import type { AppSettings, SearchEvent, SettingsPatch } from '../../../packages/core/src/types';
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export const isSessionError = (error: unknown) =>
  error instanceof ApiError && error.status === 401 && error.code === 'UNAUTHORIZED';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    priority: 'high',
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ message: '本地服务没有响应', code: 'NETWORK' }));
    throw new ApiError(data.message, data.code, response.status);
  }
  return response.json() as Promise<T>;
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export function preferSettings(current: AppSettings | undefined, saved: AppSettings): AppSettings {
  if (!current || (saved.revision ?? 0) >= (current.revision ?? 0)) return saved;
  return current;
}
let settingsWrites: Promise<AppSettings | undefined> = Promise.resolve(undefined);
const settingsChangeListeners = new Set<(settings: AppSettings) => void>();
let lastSettingsChange: AppSettings | undefined;
export function onSettingsChanged(listener: (settings: AppSettings) => void) {
  settingsChangeListeners.add(listener);
  return () => {
    settingsChangeListeners.delete(listener);
  };
}
export function putSettings(current: AppSettings, patch: SettingsPatch): Promise<AppSettings> {
  if (!current.generation)
    return Promise.reject(new ApiError('设置尚未读取，请稍后重新选择', 'SETTINGS_NOT_READY', 409));
  const generation = current.generation;
  const capturedPatch = { ...patch, ...(patch.danmaku ? { danmaku: { ...patch.danmaku } } : {}) };
  let refreshedAfterReset: AppSettings | undefined;
  const changedError = () =>
    new ApiError('资料已恢复或切换，旧的设置修改已取消，请重新选择', 'SETTINGS_CHANGED', 409);
  const changed = async (latest?: AppSettings): Promise<never> => {
    refreshedAfterReset = latest ?? (await api<AppSettings>('/settings').catch(() => undefined));
    if (
      refreshedAfterReset &&
      (!lastSettingsChange ||
        refreshedAfterReset.generation !== lastSettingsChange.generation ||
        (refreshedAfterReset.revision ?? 0) > (lastSettingsChange.revision ?? 0))
    ) {
      lastSettingsChange = refreshedAfterReset;
      for (const listener of settingsChangeListeners) listener(refreshedAfterReset);
    }
    throw changedError();
  };
  const send = async (base: AppSettings) => {
    if (base.generation !== generation) {
      refreshedAfterReset = base;
      throw changedError();
    }
    return api<AppSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        ...base,
        ...capturedPatch,
        ...(capturedPatch.danmaku
          ? {
              danmaku: {
                enabled: false,
                opacity: 0.85,
                fontScale: 1,
                ...base.danmaku,
                ...capturedPatch.danmaku,
              },
            }
          : {}),
        revision: base.revision ?? 0,
        generation,
      }),
    });
  };
  // Preserve edit order within a window; conflicts with other windows still rebase the patch.
  const saved = settingsWrites.then(async (previous) => {
    let base = preferSettings(previous, current);
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(base);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'SETTINGS_CHANGED' && error.status === 409)
          return changed(refreshedAfterReset);
        if (
          attempt === 0 &&
          error instanceof ApiError &&
          error.code === 'SETTINGS_CONFLICT' &&
          error.status === 409
        ) {
          base = await api<AppSettings>('/settings');
          continue;
        }
        throw error;
      }
    }
  });
  settingsWrites = saved.catch(() => refreshedAfterReset);
  return saved;
}
export async function searchEvents(
  keyword: string,
  sourceId: string,
  pages: Record<string, number>,
  signal: AbortSignal,
  emit: (event: SearchEvent) => void,
  refresh = false,
  cursors: Record<string, string> = {},
  session?: string,
) {
  const query = new URLSearchParams({
    q: keyword,
    sourceId,
    pages: JSON.stringify(pages),
    cursors: JSON.stringify(cursors),
    ...(refresh ? { refresh: '1' } : {}),
    ...(session ? { session } : {}),
  });
  const response = await fetch(`/api/v1/search?${query}`, { signal, priority: 'high' });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        for (const line of block.split('\n'))
          if (line.startsWith('data: ') && !signal.aborted) emit(JSON.parse(line.slice(6)) as SearchEvent);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
export const detailPath = (sourceId: string, id: string) =>
  `/anime/${encodeURIComponent(sourceId)}/${encodeURIComponent(id)}`;
export const continuePath = (sourceId: string, id: string) =>
  `/continue/${encodeURIComponent(sourceId)}/${encodeURIComponent(id)}`;
export const watchPath = (sourceId: string, id: string, line: string, episode: string, resume?: number) =>
  `/watch/${encodeURIComponent(sourceId)}/${encodeURIComponent(id)}?${new URLSearchParams({ line, episode, ...(resume !== undefined ? { resume: String(resume) } : {}) })}`;
export const timeLabel = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
