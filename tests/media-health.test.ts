import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../packages/engine/src/store';
import { Registry } from '../packages/engine/src/registry';
import { MediaGateway } from '../packages/engine/src/media';
import { AppError } from '../packages/engine/src/errors';
import { card, episode, fakeSource, response } from './helpers';

const stores: Store[] = [];
const store = () => {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) if (s.db.open) s.close();
});

describe('media health and host allowlists', () => {
  it('records MEDIA_HTTP failures except 416 and ignores AbortError', async () => {
    const registry = new Registry(store(), [fakeSource()]);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    registry.recordFailure('fixture', 'media', abort);
    expect(registry.states()[0].health.status).toBe('unknown');
    expect(registry.diagnostics).toEqual([]);

    const gateway = new MediaGateway(registry);
    const stream = vi.spyOn(registry.context('fixture').http, 'stream');
    stream.mockResolvedValue({
      url: 'https://media.example/sample.mp4',
      response: response('', {}, 403),
    });
    const playback = await gateway.create(episode().locator);
    await expect(gateway.open(playback.sessionId, playback.url.split('/').at(-1)!)).rejects.toThrow('403');
    expect(registry.states()[0].health.status).toBe('error');
    expect(registry.states()[0].health.message).toContain('403');
    expect(registry.diagnostics.some((event) => !event.ok && event.stage === 'media')).toBe(true);

    const before = registry.diagnostics.length;
    stream.mockResolvedValue({
      url: 'https://media.example/sample.mp4',
      response: response('', {}, 416),
    });
    await expect(
      gateway.open(playback.sessionId, playback.url.split('/').at(-1)!, 'bytes=0-1'),
    ).rejects.toMatchObject({ code: 'MEDIA_HTTP', status: 416 });
    expect(registry.diagnostics).toHaveLength(before);
    expect(registry.states()[0].health.status).toBe('error');
  });
  it('records detectFormat MEDIA_HTTP failures except 416', async () => {
    const registry = new Registry(store(), [
      fakeSource('fixture', {
        resolve: async () => ({ url: 'https://cdn.example/play', format: 'auto' }),
      }),
    ]);
    const gateway = new MediaGateway(registry);
    vi.spyOn(registry.context('fixture').http, 'stream').mockResolvedValue({
      url: 'https://cdn.example/play',
      response: response('', {}, 502),
    });
    await expect(gateway.create(episode().locator)).rejects.toThrow('502');
    expect(registry.states()[0].health.status).toBe('error');
    expect(registry.diagnostics.at(-1)).toMatchObject({ ok: false, stage: 'media', code: 'MEDIA_HTTP' });
  });
  it('does not treat a 416 during format detection as an unhealthy source', async () => {
    const registry = new Registry(store(), [
      fakeSource('fixture', {
        resolve: async () => ({ url: 'https://cdn.example/play', format: 'auto' }),
      }),
    ]);
    const gateway = new MediaGateway(registry);
    vi.spyOn(registry.context('fixture').http, 'stream').mockResolvedValue({
      url: 'https://cdn.example/play',
      response: response('', {}, 416),
    });
    await expect(gateway.create(episode().locator)).rejects.toThrow('416');
    expect(registry.states()[0].health.status).not.toBe('error');
    expect(registry.diagnostics.filter((event) => !event.ok)).toEqual([]);
  });
  it('passes ResolvedMedia.allowedHosts and does not substitute the source manifest list', async () => {
    const registry = new Registry(store(), [
      fakeSource('fixture', {
        resolve: async (locator) => ({
          url:
            locator.lineId === 'hls' ? 'https://cdn.example/index.m3u8' : 'https://cdn.example/sample.mp4',
          format: locator.lineId === 'hls' ? 'hls' : 'mp4',
          allowedHosts: ['cdn.example'],
        }),
      }),
    ]);
    const gateway = new MediaGateway(registry);
    const stream = vi.spyOn(registry.context('fixture').http, 'stream').mockImplementation(async (url) => ({
      url,
      response: response('ftypisom', { 'content-type': 'video/mp4' }),
    }));
    const playback = await gateway.create(episode().locator);
    await gateway.open(playback.sessionId, playback.url.split('/').at(-1)!);
    expect(stream.mock.calls[0][1]).toMatchObject({ allowedHosts: ['cdn.example'] });

    const openRegistry = new Registry(store(), [fakeSource()]);
    const openGateway = new MediaGateway(openRegistry);
    const openStream = vi
      .spyOn(openRegistry.context('fixture').http, 'stream')
      .mockImplementation(async (url) => ({
        url,
        response: response('ftypisom', { 'content-type': 'video/mp4' }),
      }));
    const openPlayback = await openGateway.create(episode().locator);
    await openGateway.open(openPlayback.sessionId, openPlayback.url.split('/').at(-1)!);
    expect(openStream.mock.calls[0][1]?.allowedHosts).toBeUndefined();
  });
  it('keeps a higher latestCount written while a check is in flight', async () => {
    const s = store();
    const entry = s.addLibrary(card, 'watching');
    const registry = new Registry(s, [
      fakeSource('fixture', {
        getDetail: async () => {
          s.saveLibrary({ ...s.getLibrary(entry.id), latestCount: 12, seenCount: 1 });
          return {
            ...card,
            lines: [{ id: 'mp4', name: 'MP4', episodes: [episode(1), episode(2)] }],
          };
        },
      }),
    ]);
    await registry.checkLibrary(entry.id);
    expect(s.getLibrary(entry.id).latestCount).toBe(12);
  });
  it('does not record AbortError from recordFailure even after a previous error', () => {
    const registry = new Registry(store(), [fakeSource()]);
    registry.recordFailure('fixture', 'media', new AppError('MEDIA_HTTP', '媒体服务器返回 403', 502));
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    registry.recordFailure('fixture', 'media', abort);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.states()[0].health.status).toBe('error');
  });
});
