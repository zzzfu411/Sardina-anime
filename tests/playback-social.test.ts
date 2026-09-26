import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DanmakuFeed, Playback } from '../packages/core/src/types';
import { createServer } from '../packages/engine/src/server';
import { AppError } from '../packages/engine/src/errors';
import type { AnimeSource } from '../packages/engine/src/sources/types';
import { episode, fakeSource, response } from './helpers';

const headers = { host: '127.0.0.1', authorization: 'Bearer social-test-token' };
const feed: DanmakuFeed = {
  comments: [{ id: 'one', time: 3, mode: 'scroll', color: '#ffffff', text: 'Hello 星星' }],
  total: 1,
  truncated: false,
  fetchedAt: '2026-09-26T00:00:00.000Z',
};
const servers: Awaited<ReturnType<typeof createServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.app.close()));
  vi.restoreAllMocks();
});

async function fixture() {
  const getDanmaku = vi.fn<NonNullable<AnimeSource['getDanmaku']>>(async () => feed);
  const updateAudience = vi.fn<NonNullable<AnimeSource['updateAudience']>>(async () => ({
    count: 8,
    scope: 'episode-line' as const,
    sampledAt: '2026-09-26T00:00:00.000Z',
  }));
  const source = fakeSource('fixture', { getDanmaku, updateAudience });
  source.manifest.capabilities.push('danmaku', 'audience');
  const server = await createServer({
    database: ':memory:',
    token: 'social-test-token',
    sources: [source, fakeSource('plain')],
    updates: false,
  });
  servers.push(server);
  const create = async (sourceId = 'fixture') => {
    const result = await server.app.inject({
      method: 'POST',
      url: '/api/v1/playbacks',
      headers,
      payload: { ...episode().locator, sourceId },
    });
    expect(result.statusCode).toBe(200);
    return result.json<Playback>();
  };
  const call = (id: string, suffix: string, method: 'GET' | 'POST' = 'POST') =>
    server.app.inject({ method, url: `/api/v1/playbacks/${id}/${suffix}`, headers });
  return { ...server, source, getDanmaku, updateAudience, create, call };
}

describe('session-scoped playback social APIs', () => {
  it('uses the registered URL, caches the feed across readers and explicitly refreshes it', async () => {
    const s = await fixture();
    const playback = await s.create();
    expect(playback.features).toEqual(['danmaku', 'audience']);
    const [first, second] = await Promise.all([
      s.call(playback.sessionId, 'danmaku', 'GET'),
      s.call(playback.sessionId, 'danmaku', 'GET'),
    ]);
    expect(first.json()).toEqual(feed);
    expect(second.json()).toEqual(feed);
    expect(s.getDanmaku).toHaveBeenCalledTimes(1);
    expect(s.getDanmaku.mock.calls[0][0]).toMatchObject({ url: 'https://media.example/sample.mp4' });
    expect(JSON.stringify(playback)).not.toContain('media.example');
    await s.call(playback.sessionId, 'danmaku?refresh=1', 'GET');
    expect(s.getDanmaku).toHaveBeenCalledTimes(2);
    await s.app.inject({ method: 'POST', url: '/api/v1/cache/clear', headers });
    await s.call(playback.sessionId, 'danmaku', 'GET');
    expect(s.getDanmaku).toHaveBeenCalledTimes(3);
  });
  it('does not accept arbitrary URLs, unauthenticated reads or unsupported sources', async () => {
    const s = await fixture();
    const playback = await s.create();
    const url = `/api/v1/playbacks/${playback.sessionId}`;
    expect((await s.app.inject({ url: url + '/danmaku', headers: { host: '127.0.0.1' } })).statusCode).toBe(
      401,
    );
    expect((await s.call(playback.sessionId, 'danmaku?url=https://evil.example/', 'GET')).statusCode).toBe(
      400,
    );
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: url + '/audience',
          headers,
          payload: { play_url: 'https://evil.example/' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await s.call('not-a-session', 'danmaku', 'GET')).statusCode).toBe(400);
    const plain = await s.create('plain');
    expect(plain.features).toEqual([]);
    expect((await s.call(plain.sessionId, 'danmaku', 'GET')).statusCode).toBe(422);
    expect((await s.call(plain.sessionId, 'audience')).statusCode).toBe(422);
    expect(s.getDanmaku).not.toHaveBeenCalled();
    expect(s.updateAudience).not.toHaveBeenCalled();
  });
  it('keeps video playable and its health intact when danmaku fails', async () => {
    const s = await fixture();
    const playback = await s.create();
    const health = s.registry.states()[0].health;
    s.getDanmaku.mockRejectedValue(new AppError('DANMAKU_UNAVAILABLE', '弹幕暂不可用'));
    expect((await s.call(playback.sessionId, 'danmaku', 'GET')).statusCode).toBe(502);
    expect(s.registry.states()[0].health).toEqual(health);
    vi.spyOn(s.registry.context('fixture').http, 'stream').mockResolvedValue({
      url: 'https://media.example/sample.mp4',
      response: response('ftypisom', { 'content-type': 'video/mp4' }),
    });
    expect((await s.app.inject({ url: playback.url, headers })).statusCode).toBe(200);
  });
  it('deduplicates entry and heartbeats, then pairs only one leave with the original refreshed URL', async () => {
    const s = await fixture();
    const playback = await s.create();
    const first = await Promise.all([
      s.call(playback.sessionId, 'audience'),
      s.call(playback.sessionId, 'audience'),
    ]);
    expect(first.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(first[0].json()).toEqual(first[1].json());
    s.source.resolve = async () => ({ url: 'https://media.example/refreshed.mp4', format: 'mp4' });
    await s.call(playback.sessionId, 'refresh');
    expect((await s.call(playback.sessionId, 'audience')).json()).toEqual(first[0].json());
    expect(s.updateAudience).toHaveBeenCalledTimes(1);
    s.store.saveSourceSettings('fixture', false, 0);
    expect((await s.call(playback.sessionId, 'danmaku', 'GET')).statusCode).toBe(409);
    await Promise.all([
      s.call(playback.sessionId, 'audience/close'),
      s.call(playback.sessionId, 'audience/close'),
    ]);
    expect(s.updateAudience).toHaveBeenCalledTimes(2);
    expect(s.updateAudience.mock.calls[1][0]).toMatchObject({ url: 'https://media.example/sample.mp4' });
    expect(s.updateAudience.mock.calls[1][1]).toBe('close');
  });
  it('closes audience on playback deletion and service shutdown, even after the source is disabled', async () => {
    const s = await fixture();
    const one = await s.create();
    const two = await s.create();
    await s.call(one.sessionId, 'audience');
    await s.call(two.sessionId, 'audience');
    await s.app.inject({ method: 'DELETE', url: `/api/v1/playbacks/${one.sessionId}`, headers });
    expect(s.updateAudience).toHaveBeenCalledTimes(3);
    expect((await s.call(one.sessionId, 'danmaku', 'GET')).statusCode).toBe(410);
    s.store.saveSourceSettings('fixture', false, 0);
    await s.app.close();
    expect(s.updateAudience).toHaveBeenCalledTimes(4);
  });
  it('fences close-before-entry and rejects reopening a closed lease without affecting the video session', async () => {
    const s = await fixture();
    const playback = await s.create();
    await s.call(playback.sessionId, 'audience/close');
    expect((await s.call(playback.sessionId, 'audience')).statusCode).toBe(409);
    expect(s.updateAudience).not.toHaveBeenCalled();
    expect((await s.call(playback.sessionId, 'danmaku', 'GET')).statusCode).toBe(200);
    // Bounded tombstone eviction must not permit a still-valid playback to register again.
    for (let i = 0; i < 257; i++) await s.call(randomUUID(), 'audience/close');
    expect((await s.call(playback.sessionId, 'audience')).statusCode).toBe(409);
    expect(s.updateAudience).not.toHaveBeenCalled();
  });
  it('persists bounded danmaku settings and round-trips old backups without requiring the new field', async () => {
    const s = await fixture();
    const settings = s.store.settings();
    expect(settings.danmaku).toEqual({ enabled: false, opacity: 0.85, fontScale: 1 });
    const saved = await s.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers,
      payload: { ...settings, danmaku: { enabled: true, opacity: 0.5, fontScale: 1.25 } },
    });
    expect(saved.statusCode).toBe(200);
    expect(s.store.export().settings.danmaku).toEqual({ enabled: true, opacity: 0.5, fontScale: 1.25 });
    const backup = s.store.export();
    delete backup.settings.danmaku;
    s.store.restore(backup);
    expect(s.store.settings().danmaku).toEqual({ enabled: false, opacity: 0.85, fontScale: 1 });
    const invalid = await s.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers,
      payload: { ...s.store.settings(), danmaku: { enabled: true, opacity: 2, fontScale: 99 } },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
