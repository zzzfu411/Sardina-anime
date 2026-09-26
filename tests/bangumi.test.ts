import { afterEach, expect, it, vi } from 'vitest';
import { BangumiClient, exactBangumiMatch, parseBangumiSubject } from '../packages/engine/src/bangumi';
import { HttpClient } from '../packages/engine/src/http';
import { createServer } from '../packages/engine/src/server';
import { card, fakeSource } from './helpers';

afterEach(() => vi.restoreAllMocks());
const raw = (patch = {}) => ({
  id: 42,
  type: 2,
  name: 'Stars',
  name_cn: '星空放映室',
  date: '2026-07-01',
  platform: 'TV',
  infobox: [{ key: '别名', value: [{ v: '星空剧场' }] }],
  rating: { score: 8.2, total: 512, rank: 130 },
  ...patch,
});
const anime = { ...card, season: undefined };

it('reads official score/count/rank and excludes unscored or non-animation subjects', () => {
  expect(parseBangumiSubject(raw())).toMatchObject({
    id: '42',
    score: 8.2,
    total: 512,
    rank: 130,
    kind: 'tv',
    aliases: ['星空剧场'],
  });
  expect(parseBangumiSubject(raw({ rating: { score: 0, total: 0, rank: 0 } }))).toMatchObject({ total: 0 });
  expect(parseBangumiSubject(raw({ rating: { score: 0, total: 0, rank: 0 } })).score).toBeUndefined();
  expect(() => parseBangumiSubject(raw({ type: 1 }))).toThrow('不是动画');
  expect(() => parseBangumiSubject(raw({ rating: { score: 99, total: 1, rank: 1 } }))).toThrow('结构');
  expect(() => parseBangumiSubject({})).toThrow('结构');
});
it('requires exact titles/aliases, known year and format, and consistent seasons', () => {
  const subject = parseBangumiSubject(raw());
  expect(exactBangumiMatch(anime, subject)).toBe(true);
  expect(exactBangumiMatch({ ...anime, title: '星空剧场' }, subject)).toBe(true);
  for (const patch of [
    { year: 2025 },
    { year: undefined },
    { kind: 'movie' as const },
    { kind: 'unknown' as const },
    { season: 2 },
    { title: '星空放映室 特别篇' },
  ])
    expect(exactBangumiMatch({ ...anime, ...patch }, subject)).toBe(false);
});
it('deduplicates/caches public requests with a bounded timeout and sends only animation filters', async () => {
  const http = new HttpClient();
  const read = vi
    .spyOn(http, 'json')
    .mockImplementation(async (url) => (url.includes('/search/') ? { data: [raw()], total: 1 } : raw()));
  const api = new BangumiClient(http);
  try {
    const [a, b] = await Promise.all([api.match(anime), api.match(anime)]);
    expect(a).toMatchObject({ status: 'matched', match: 'exact', subject: { id: '42' } });
    expect(b).toEqual(a);
    await api.match(anime);
    expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.parse(read.mock.calls[0][1]!.body!)).toMatchObject({ filter: { type: [2], nsfw: false } });
    expect(read.mock.calls[0][1]).toMatchObject({ allowedHosts: ['api.bgm.tv'], timeout: 8000 });
    api.clearCache();
    await api.match(anime);
    expect(read).toHaveBeenCalledTimes(4);
  } finally {
    api.close();
  }
});
it('never picks the first fuzzy, ambiguous or truncated search result', async () => {
  const http = new HttpClient();
  const read = vi.spyOn(http, 'json');
  const api = new BangumiClient(http);
  try {
    for (const page of [
      { data: [raw(), raw({ id: 43 })], total: 2 },
      { data: [raw()], total: 40 },
      { data: [raw({ name_cn: '星空放映室 后篇', infobox: [] })], total: 1 },
    ]) {
      api.clearCache();
      read.mockResolvedValue(page);
      expect(await api.match(anime)).toMatchObject({ status: 'ambiguous' });
    }
    api.clearCache();
    read.mockResolvedValue({ data: [], total: 0 });
    expect(await api.match(anime)).toEqual({ status: 'not-found', candidates: [] });
  } finally {
    api.close();
  }
});
it('uses explicit IDs without keyword search, but known conflicts require confirmation', async () => {
  const http = new HttpClient();
  const read = vi.spyOn(http, 'json').mockResolvedValue(raw());
  const api = new BangumiClient(http);
  try {
    expect(await api.match({ ...anime, externalIds: { bangumi: '42' } })).toMatchObject({
      match: 'external-id',
    });
    expect(await api.match({ ...anime, year: 2025, externalIds: { bangumi: '42' } })).toMatchObject({
      status: 'ambiguous',
    });
    expect(await api.match({ ...anime, year: 2025 }, '42')).toMatchObject({ match: 'manual' });
    await expect(api.subject('https://127.0.0.1')).rejects.toThrow('编号');
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    api.close();
  }
});
it('lets another reader continue when one rating request is cancelled', async () => {
  const http = new HttpClient();
  let finish!: (value: unknown) => void;
  vi.spyOn(http, 'json').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const api = new BangumiClient(http),
    controller = new AbortController();
  try {
    const cancelled = api.subject('42', controller.signal),
      remaining = api.subject('42');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort();
    await expect(cancelled).rejects.toHaveProperty('name', 'AbortError');
    finish(raw());
    expect(await remaining).toMatchObject({ id: '42' });
  } finally {
    api.close();
  }
});
it('keeps ratings optional, validates associations, and round-trips them in old-compatible backups', async () => {
  const server = await createServer({
    database: ':memory:',
    token: 'ratings-token',
    sources: [fakeSource()],
    updates: false,
  });
  const headers = { host: '127.0.0.1', authorization: 'Bearer ratings-token' };
  const read = vi.spyOn(server.bangumi.http, 'json').mockRejectedValue(new Error('metadata unavailable'));
  try {
    expect(
      (await server.app.inject({ url: '/api/v1/sources/fixture/detail?itemId=one', headers })).statusCode,
    ).toBe(200);
    expect(read).not.toHaveBeenCalled();
    expect(
      (await server.app.inject({ url: '/api/v1/sources/fixture/ratings?itemId=one', headers })).statusCode,
    ).toBe(500);
    expect(server.registry.states()[0].health.status).toBe('ok');
    read.mockResolvedValue(raw({ type: 1 }));
    const link = (subjectId: string) =>
      server.app.inject({
        method: 'PUT',
        url: '/api/v1/sources/fixture/bangumi',
        headers,
        payload: { itemId: 'one', subjectId },
      });
    expect((await link('42')).statusCode).toBe(400);
    expect((await link('0')).statusCode).toBe(400);
    expect(server.store.bangumiLinks()).toEqual([]);
    read.mockResolvedValue(raw());
    expect((await link('42')).json()).toMatchObject({ status: 'matched', match: 'manual' });
    expect(
      (await server.app.inject({ url: '/api/v1/sources/fixture/ratings?itemId=one', headers })).json(),
    ).toMatchObject({ subject: { id: '42', score: 8.2 } });
    const backup = server.store.export();
    server.store.linkBangumi(card);
    server.store.restore(backup);
    expect(server.store.bangumiLinks()).toEqual([{ sourceId: 'fixture', id: 'one', subjectId: '42' }]);
    expect(() =>
      server.store.restore({ ...backup, bangumiLinks: [...backup.bangumiLinks, ...backup.bangumiLinks] }),
    ).toThrow('重复');
    const { bangumiLinks, ...old } = backup;
    server.store.restore(old);
    expect(server.store.bangumiLinks()).toEqual([]);
    expect(
      (await server.app.inject({ url: '/api/v1/bangumi/subjects/42', headers: { host: '127.0.0.1' } }))
        .statusCode,
    ).toBe(401);
  } finally {
    await server.app.close();
  }
});
