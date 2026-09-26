import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../packages/core/src/types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const initial: AppSettings = {
  autoNext: true,
  volume: 0.8,
  playbackRate: 1,
  appearance: 'light',
  revision: 0,
  generation: '11111111-1111-4111-8111-111111111111',
};
function settingsServer() {
  let stored = { ...initial };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const input = JSON.parse(String(init.body)) as AppSettings;
      if (input.generation !== stored.generation)
        return Response.json({ code: 'SETTINGS_CHANGED', message: 'changed' }, { status: 409 });
      if (input.revision !== stored.revision)
        return Response.json({ code: 'SETTINGS_CONFLICT', message: 'conflict' }, { status: 409 });
      stored = { ...input, revision: stored.revision! + 1 };
    }
    return Response.json(stored);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, current: () => stored };
}

describe('settings saves across overlapping edits', () => {
  it('preserves separate danmaku edits when earlier saves are still in flight', async () => {
    const server = settingsServer();
    const { putSettings } = await import('../apps/web/src/api');
    await Promise.all([
      putSettings(initial, { danmaku: { enabled: true } }),
      putSettings(initial, { danmaku: { opacity: 0.5 } }),
      putSettings(initial, { danmaku: { fontScale: 1.25 } }),
    ]);
    expect(server.current()).toMatchObject({
      danmaku: { enabled: true, opacity: 0.5, fontScale: 1.25 },
      revision: 3,
    });
  });
  it('preserves the last edit and unrelated fields across three simultaneous changes', async () => {
    const server = settingsServer();
    const { putSettings } = await import('../apps/web/src/api');
    await expect(
      Promise.all([
        putSettings(initial, { appearance: 'dark' }),
        putSettings(initial, { volume: 0.4 }),
        putSettings(initial, { volume: 0.2, playbackRate: 1.5 }),
      ]),
    ).resolves.toHaveLength(3);
    expect(server.current()).toMatchObject({
      appearance: 'dark',
      volume: 0.2,
      playbackRate: 1.5,
      revision: 3,
    });
  });
  it('merges only the requested change after another window advances the revision', async () => {
    const server = settingsServer();
    await server.fetch('/api/v1/settings', {
      method: 'PUT',
      body: JSON.stringify({ ...initial, appearance: 'dark' }),
    });
    const { putSettings } = await import('../apps/web/src/api');
    await expect(putSettings(initial, { volume: 0.2 })).resolves.toMatchObject({
      appearance: 'dark',
      volume: 0.2,
      revision: 2,
    });
  });
  it('allows later saves after a failed request and keeps newer cached responses', async () => {
    const server = settingsServer();
    server.fetch.mockRejectedValueOnce(new TypeError('offline'));
    const { putSettings, preferSettings } = await import('../apps/web/src/api');
    await expect(putSettings(initial, { volume: 0.1 })).rejects.toThrow('offline');
    const saved = await putSettings(initial, { volume: 0.3 });
    expect(saved.volume).toBe(0.3);
    expect(preferSettings(saved, initial)).toBe(saved);
  });
  it('does not rebase an old patch onto settings restored between a conflict and its retry', async () => {
    const restored = {
      ...initial,
      generation: '22222222-2222-4222-8222-222222222222',
      revision: 3,
      appearance: 'dark' as const,
    };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ code: 'SETTINGS_CONFLICT', message: 'conflict' }, { status: 409 })
        : Response.json(restored),
    );
    vi.stubGlobal('fetch', fetch);
    const { putSettings, onSettingsChanged } = await import('../apps/web/src/api');
    const refresh = vi.fn();
    const stop = onSettingsChanged(refresh);
    await expect(putSettings(initial, { appearance: 'light' })).rejects.toMatchObject({
      code: 'SETTINGS_CHANGED',
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(restored);
    stop();
  });
  it('keeps queued patches bound to their calling generation while allowing a fresh post-restore edit', async () => {
    const restored = {
      ...initial,
      generation: '22222222-2222-4222-8222-222222222222',
      revision: 3,
      volume: 0.7,
    };
    let stored = restored;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const value = JSON.parse(String(init.body)) as AppSettings;
        if (value.generation !== stored.generation)
          return Response.json({ code: 'SETTINGS_CHANGED', message: 'changed' }, { status: 409 });
        stored = { ...stored, ...value, revision: stored.revision + 1 };
      }
      return Response.json(stored);
    });
    vi.stubGlobal('fetch', fetch);
    const { putSettings, onSettingsChanged } = await import('../apps/web/src/api');
    const refresh = vi.fn();
    const stop = onSettingsChanged(refresh);
    const result = await Promise.allSettled([
      putSettings(initial, { volume: 0.1 }),
      putSettings(initial, { playbackRate: 3 }),
      putSettings(restored, { appearance: 'dark' }),
    ]);
    expect(result.map((value) => value.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    expect(stored).toMatchObject({
      volume: 0.7,
      playbackRate: 1,
      appearance: 'dark',
      generation: restored.generation,
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
    expect(fetch.mock.calls.filter(([, init]) => init?.method !== 'PUT')).toHaveLength(1);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(restored);
    stop();
  });
  it('refreshes after a restore arrives between conflict recovery and the retried write', async () => {
    const restored = { ...initial, generation: '22222222-2222-4222-8222-222222222222', revision: 4 };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ code: 'SETTINGS_CONFLICT', message: 'conflict' }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ ...initial, revision: 2 }))
      .mockResolvedValueOnce(Response.json({ code: 'SETTINGS_CHANGED', message: 'changed' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(restored));
    vi.stubGlobal('fetch', fetch);
    const { putSettings, onSettingsChanged } = await import('../apps/web/src/api');
    const refresh = vi.fn();
    const stop = onSettingsChanged(refresh);
    await expect(putSettings(initial, { volume: 0.1 })).rejects.toMatchObject({ code: 'SETTINGS_CHANGED' });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(restored);
    stop();
  });
  it('never sends a new client write before a settings generation has been loaded', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { putSettings } = await import('../apps/web/src/api');
    const { generation: _, ...unloaded } = initial;
    await expect(putSettings(unloaded, { volume: 0.1 })).rejects.toMatchObject({
      code: 'SETTINGS_NOT_READY',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
