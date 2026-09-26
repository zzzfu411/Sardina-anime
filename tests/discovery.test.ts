import { afterEach, expect, it, vi } from 'vitest';
import { AkiSource, parseAkiCatalog } from '../packages/engine/src/sources/aki';
import { AniChSource, decodeAniPage } from '../packages/engine/src/sources/anich';
import { HttpClient } from '../packages/engine/src/http';
import { AppError } from '../packages/engine/src/errors';
import { createServer } from '../packages/engine/src/server';
import { Registry } from '../packages/engine/src/registry';
import { Store } from '../packages/engine/src/store';
import { refineSearch } from '../packages/core/src/discovery';
import { card, discoverySource } from './helpers';

afterEach(() => vi.restoreAllMocks());
const apiData = {
  code: 1,
  total: 41,
  pagecount: 2,
  list: [
    {
      url: '/bgmdetail/publicID.html',
      vod_id: 101,
      vod_name: '海风 &amp; 星空',
      vod_pic: '/poster.jpg',
      vod_blurb: '<p>简介</p>',
      vod_year: 2024,
    },
  ],
};
it('uses public detail IDs and real pagination rather than guessing IDs from API numeric keys', () => {
  const result = parseAkiCatalog(apiData, 2);
  expect(result).toMatchObject({
    total: 41,
    pageCount: 2,
    hasMore: false,
    items: [
      {
        id: 'publicID',
        title: '海风 & 星空',
        year: 2024,
        description: '简介',
        poster: 'https://www.akianime.com/poster.jpg',
      },
    ],
  });
  expect(() => parseAkiCatalog({ code: 1, list: [{ vod_id: 101, vod_name: 'missing URL' }] }, 1)).toThrow();
  expect(() => parseAkiCatalog({ code: 1, list: {} }, 1)).toThrow();
  expect(parseAkiCatalog({ code: 2, list: [] }, 1).items).toEqual([]);
});
it('sends AniCh filters and the upstream cursor without inventing an offset', async () => {
  const http = new HttpClient();
  const bytes = vi
    .spyOn(http, 'bytes')
    .mockResolvedValue({ body: Buffer.alloc(0), url: '', contentType: 'application/octet-stream' });
  await new AniChSource().getCatalog(
    { page: 3, cursor: '33760', filters: { year: '2024', type: 'movie', lang: 'ja' } },
    { http },
  );
  const url = new URL(bytes.mock.calls[0][0]);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    skip: '33760',
    year: '2024',
    type: 'movie',
    lang: 'ja',
    nsfw: 'false',
    res: 'true',
  });
  await expect(new AniChSource().search({ keyword: '星空', page: 2 }, { http })).rejects.toMatchObject({
    code: 'MISSING_CURSOR',
  });
  await new AniChSource().search({ keyword: '星空', page: 2, cursor: '33760' }, { http });
  expect(new URL(bytes.mock.calls.at(-1)![0]).searchParams.get('skip')).toBe('33760');
});
it('reads AniCh continuation metadata even when a page contains fewer than 50 cards', () => {
  const one = Buffer.from([10, 5, 8, 7, 18, 1, 88]);
  expect(decodeAniPage(Buffer.concat([one, Buffer.from([24, 99])]), 1)).toMatchObject({
    items: [{ id: '7' }],
    hasMore: true,
    nextCursor: '99',
  });
  expect(decodeAniPage(Buffer.concat([one, Buffer.from([24, 0])]), 2)).toMatchObject({
    hasMore: false,
    nextCursor: undefined,
  });
});
it('extracts calendar anime IDs from episode links and rejects foreign links', () => {
  const raw = {
    ...apiData,
    list: [
      { ...apiData.list[0], url: '/bgmplay/j3cDDE-1-1.html' },
      { ...apiData.list[0], url: 'https://www.akianime.com/bgmdetail/absolute.html' },
      { ...apiData.list[0], url: 'https://other.example/bgmdetail/foreign.html' },
    ],
  };
  expect(parseAkiCatalog(raw, 1).items.map((c) => c.id)).toEqual(['j3cDDE', 'absolute']);
});
it('retains release years when AniCh uses a numeric timestamp', async () => {
  const http = new HttpClient();
  vi.spyOn(http, 'json').mockResolvedValue({ title: '测试番剧', airdate: Date.UTC(2024, 0, 1) });
  vi.spyOn(http, 'bytes').mockResolvedValue({ body: Buffer.alloc(0), url: '', contentType: '' });
  expect((await new AniChSource().getDetail({ sourceId: 'anich', id: '7' }, { http })).year).toBe(2024);
});
it('never invents card metadata from catalog filters when a source index differs from its details', async () => {
  const http = new HttpClient();
  const tag = Buffer.from('2025/动画');
  const entry = Buffer.concat([Buffer.from([8, 7, 18, 1, 88, 42, tag.length]), tag]);
  const bytes = vi
    .spyOn(http, 'bytes')
    .mockResolvedValue({
      body: Buffer.concat([Buffer.from([10, entry.length]), entry]),
      url: '',
      contentType: '',
    });
  const source = new AniChSource();
  expect((await source.getCatalog({ page: 1, filters: { year: '2024' } }, { http })).items[0].year).toBe(
    2025,
  );
  bytes.mockResolvedValue({ body: Buffer.from([10, 5, 8, 7, 18, 1, 88]), url: '', contentType: '' });
  expect(
    (await source.getCatalog({ page: 1, filters: { year: '2024' } }, { http })).items[0].year,
  ).toBeUndefined();
  vi.spyOn(http, 'text').mockResolvedValue('<html/>');
  vi.spyOn(http, 'json').mockResolvedValue({
    ...apiData,
    list: [{ ...apiData.list[0], vod_year: undefined }],
  });
  expect(
    (await new AkiSource().getCatalog({ page: 1, filters: { year: '2024' } }, { http })).items[0].year,
  ).toBeUndefined();
});
it('warms the Aki session and retries malformed HTML once without changing catalog filters', async () => {
  const http = new HttpClient();
  const text = vi.spyOn(http, 'text').mockResolvedValue('<html/>');
  const json = vi
    .spyOn(http, 'json')
    .mockRejectedValueOnce(new AppError('INVALID_RESPONSE', 'HTML'))
    .mockResolvedValueOnce(apiData);
  const result = await new AkiSource().getCatalog(
    { page: 2, filters: { year: '2024', genre: '恋爱', sort: 'score' } },
    { http },
  );
  expect(text).toHaveBeenCalledTimes(2);
  const params = new URLSearchParams(json.mock.calls[1][1]?.body);
  expect(Object.fromEntries(params)).toMatchObject({ class: '恋爱', year: '2024', by: 'score', page: '2' });
  expect(result.items[0].id).toBe('publicID');
});
it('reads the actual requested weekday without inventing an update time', async () => {
  const http = new HttpClient();
  vi.spyOn(http, 'text').mockResolvedValue('<html/>');
  const json = vi.spyOn(http, 'json').mockResolvedValue(apiData);
  const day = await new AkiSource().getSchedule(7, { http });
  expect(json.mock.calls[0][0]).toBe('https://www.akianime.com/index.php/ds_api/weekday');
  expect(new URLSearchParams(json.mock.calls[0][1]?.body).get('weekday')).toBe('日');
  expect(day).toMatchObject({ weekday: 7, items: [{ id: 'publicID' }] });
  expect(day.items[0]).not.toHaveProperty('updatedAt');
});
it('isolates catalog cache by source, page and all filters, supports refresh, and respects disabled sources', async () => {
  const store = new Store(':memory:');
  try {
    const source = discoverySource();
    const get = vi.fn(source.getCatalog!);
    source.getCatalog = get;
    const registry = new Registry(store, [source]);
    await registry.catalog('fixture', { page: 1, filters: { year: '2024', type: 'movie' } });
    await registry.catalog('fixture', { page: 1, filters: { type: 'movie', year: '2024' } });
    expect(get).toHaveBeenCalledTimes(1);
    await registry.catalog('fixture', { page: 2, filters: { type: 'movie', year: '2024' } });
    await registry.catalog('fixture', { page: 1, filters: { year: '2026' } });
    await registry.catalog('fixture', { page: 1, filters: { year: '2026' } }, undefined, true);
    expect(get).toHaveBeenCalledTimes(4);
    await registry.catalog('fixture', { page: 2, cursor: '99', filters: {} });
    await registry.catalog('fixture', { page: 2, cursor: '101', filters: {} });
    await registry.catalog('fixture', { page: 2, cursor: '99', filters: {} });
    expect(get).toHaveBeenCalledTimes(6);
    expect(get.mock.calls.at(-1)?.[0].cursor).toBe('101');
    await expect(
      registry.catalog('fixture', { page: 1, filters: { region: 'fictional' } }),
    ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
    store.saveSourceSettings('fixture', false, 0);
    await expect(registry.catalog('fixture', { page: 1, filters: {} })).rejects.toMatchObject({
      code: 'SOURCE_DISABLED',
    });
  } finally {
    store.close();
  }
});
it('cancels catalogue work even if an adapter ignores the signal', async () => {
  const store = new Store(':memory:');
  try {
    const source = discoverySource();
    source.getCatalog = () => new Promise(() => {});
    const registry = new Registry(store, [source]);
    const controller = new AbortController();
    const pending = registry.catalog('fixture', { page: 1, filters: {} }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  } finally {
    store.close();
  }
});
it('keeps missing year and type distinct and sorts only the returned search records', () => {
  const cards = [
    { ...card, id: 'unknown', year: undefined, kind: 'unknown' as const },
    { ...card, id: 'old', year: 2020 },
    card,
  ];
  expect(refineSearch(cards, '', 'unknown', '').map((c) => c.id)).toEqual(['unknown']);
  expect(refineSearch(cards, 'tv', '', 'year').map((c) => c.id)).toEqual(['one', 'old']);
  expect(cards[0].id).toBe('unknown');
});
it('persists bounded, deduplicated recent searches and supports old backups', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 25; i++) store.rememberSearch('片名' + i);
    store.rememberSearch('  星空   放映室  ');
    store.rememberSearch('星空 放映室');
    expect(store.searchHistory()).toHaveLength(20);
    expect(store.searchHistory()[0].keyword).toBe('星空 放映室');
    const backup = store.export();
    store.clearSearchHistory();
    store.restore(backup);
    expect(store.searchHistory()).toEqual(backup.searchHistory);
    store.clearSearchHistory('星空 放映室');
    expect(store.searchHistory()).toHaveLength(19);
    const { searchHistory: _, ...old } = backup;
    store.restore(old);
    expect(store.searchHistory()).toEqual([]);
  } finally {
    store.close();
  }
});
it('authenticates discovery endpoints, validates paging/weekdays, and records real searches', async () => {
  const source = discoverySource();
  const search = vi.spyOn(source, 'search');
  const server = await createServer({
    database: ':memory:',
    token: 'fixture-token',
    sources: [source],
    updates: false,
  });
  const headers = { host: '127.0.0.1', authorization: 'Bearer fixture-token' };
  try {
    expect(
      (await server.app.inject({ url: '/api/v1/catalog?sourceId=fixture', headers: { host: '127.0.0.1' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await server.app.inject({ url: '/api/v1/catalog?sourceId=fixture&page=0', headers })).statusCode,
    ).toBe(400);
    expect(
      (await server.app.inject({ url: '/api/v1/schedule?sourceId=fixture&weekday=8', headers })).statusCode,
    ).toBe(400);
    const catalog = await server.app.inject({
      url: '/api/v1/catalog?sourceId=fixture&filters=' + encodeURIComponent(JSON.stringify({ year: '2024' })),
      headers,
    });
    expect(catalog.json()).toMatchObject({
      total: 1,
      items: [{ id: 'movie', imageUrl: expect.stringMatching(/^\/api\/v1\/images\//) }],
    });
    const day = await server.app.inject({ url: '/api/v1/schedule?sourceId=fixture&weekday=1', headers });
    expect(day.json().items).toHaveLength(1);
    await server.app.inject({ url: '/api/v1/search?q=' + encodeURIComponent('星空'), headers });
    await server.app.inject({
      url:
        '/api/v1/search?' +
        new URLSearchParams({
          q: '星空',
          pages: JSON.stringify({ fixture: 2 }),
          cursors: JSON.stringify({ fixture: '33760' }),
        }),
      headers,
    });
    expect(search.mock.calls.at(-1)?.[0]).toEqual({ keyword: '星空', page: 2, cursor: '33760' });
    expect((await server.app.inject({ url: '/api/v1/search-history', headers })).json()[0].keyword).toBe(
      '星空',
    );
    expect(
      (await server.app.inject({ method: 'DELETE', url: '/api/v1/search-history', headers })).json(),
    ).toEqual([]);
  } finally {
    await server.app.close();
  }
});
