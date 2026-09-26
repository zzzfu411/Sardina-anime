import { expect, it, vi, afterEach } from 'vitest';
import { HttpClient, validateUrl } from '../packages/engine/src/http';
import {
  parseXifanDetail,
  parseXifanMedia,
  parseXifanPage,
  XifanSource,
  XIFAN_MEDIA_ORIGINS,
} from '../packages/engine/src/sources/xifan';
afterEach(() => vi.restoreAllMocks());
const anime = {
  id: 3,
  title: '示例 第三季',
  format: 'tv',
  release_year: 2026,
  season_number: 5,
  requires_comprehensive: false,
};
const data = {
  anime,
  sources: [
    {
      id: 4,
      code: 'xfxf1',
      name: '公开主线',
      episodes: [
        { id: 17, kind: 'main', episode_number: 12.5, title: '间奏', available_at: '2026-01-01T00:00:00Z' },
      ],
    },
    { id: 1, code: 'AL', name: '未验证线路', episodes: [{ id: 17, episode_number: 12.5 }] },
  ],
};
const locator = { sourceId: 'xifan', animeId: '3', lineId: '4', episodeId: '17' };
it('preserves a Bangumi snapshot as source-supplied metadata, excluding missing or zero votes', () => {
  const result = parseXifanDetail(
    { ...data, anime: { ...anime, bangumi_score: 8.2, bangumi_rating_total: 4234 } },
    '3',
  );
  expect(result.ratings).toEqual([
    { label: 'Bangumi · 稀饭收录', score: 8.2, total: 4234, origin: 'bangumi-snapshot' },
  ]);
  expect(parseXifanDetail({ ...data, anime: { ...anime, bangumi_score: 0 } }, '3').ratings).toEqual([]);
  expect(
    parseXifanDetail({ ...data, anime: { ...anime, bangumi_score: '8.1', bangumi_rating_total: '0' } }, '3')
      .ratings,
  ).toEqual([]);
});
it('reads actual counts and preserves the title season instead of the series order', () => {
  const page = parseXifanPage([{ ...anime, total_count: 25 }], 1);
  expect(page).toMatchObject({
    pageCount: 2,
    total: 25,
    hasMore: true,
    items: [{ season: 3, kind: 'tv', year: 2026 }],
  });
  expect(parseXifanPage([], 1)).toMatchObject({ items: [], hasMore: false });
  expect(() => parseXifanPage([anime], 1)).toThrow('分页总数');
  expect(() => parseXifanPage([{ ...anime, total_count: 25 }], 3)).toThrow('页码');
});
it('keeps stable episode IDs, decimal numbering and only the verified public line', () => {
  const detail = parseXifanDetail(data, '3');
  expect(detail.lines).toHaveLength(1);
  expect(detail.lines[0].episodes[0]).toMatchObject({ id: '17', number: 12.5, locator });
  expect(() => parseXifanDetail(data, '4')).toThrow('不匹配');
});
it('does not expose exam-gated anime or scheduled future episodes', () => {
  expect(() => parseXifanDetail({ ...data, anime: { ...anime, requires_comprehensive: true } }, '3')).toThrow(
    '考试权限',
  );
  expect(() =>
    parseXifanDetail(
      {
        ...data,
        sources: [
          {
            ...data.sources[0],
            episodes: [{ ...data.sources[0].episodes[0], available_at: '2099-01-01T00:00:00Z' }],
          },
        ],
      },
      '3',
    ),
  ).toThrow('公开主线');
});
it('checks signed media belongs to the selected anime, episode and source', () => {
  const response = {
    ok: true,
    anime_id: 3,
    episode_id: 17,
    candidates: [{ source_id: 4, source_code: 'xfxf1', url: 'https://cdn.example/video.mp4' }],
  };
  expect(parseXifanMedia(response, locator)).toMatchObject({
    format: 'mp4',
    allowedPortOrigins: XIFAN_MEDIA_ORIGINS,
  });
  expect(() => parseXifanMedia({ ...response, episode_id: 18 }, locator)).toThrow('当前剧集');
  expect(() =>
    parseXifanMedia(
      { ...response, candidates: [{ source_id: 1, url: 'https://cdn.example/video.mp4' }] },
      locator,
    ),
  ).toThrow('所选');
  expect(() => parseXifanMedia({ ok: false, error: 'forbidden' }, locator)).toThrow('授权');
  expect(() =>
    parseXifanMedia(
      {
        ...response,
        candidates: [{ source_id: 4, source_code: 'xfxf1', url: 'http://192.168.1.1/private' }],
      },
      locator,
    ),
  ).toThrow('本地');
});
it('uses the observed public RPC parameters without a user authorization header', async () => {
  const http = new HttpClient();
  const request = vi.spyOn(http, 'json').mockResolvedValue([{ ...anime, total_count: 1 }]);
  await new XifanSource().getCatalog({ page: 1, filters: { year: '2024', format: 'tv' } }, { http });
  expect(request.mock.calls[0][0]).toBe('https://api.xifanacg.com/rest/v1/rpc/search_animes');
  expect(JSON.parse(request.mock.calls[0][1]!.body!)).toMatchObject({
    filter_release_year: 2024,
    filter_format: 'tv',
    filter_only_published: true,
  });
  expect(request.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
});
it('allows an exact CDN origin only and keeps private addresses and other ports blocked', () => {
  expect(() => validateUrl('https://bjdownload.pan.wo.cn:30443/video')).toThrow('访问规则');
  expect(validateUrl('https://bjdownload.pan.wo.cn:30443/video', undefined, XIFAN_MEDIA_ORIGINS).port).toBe(
    '30443',
  );
  for (const url of [
    'http://bjdownload.pan.wo.cn:30443/video',
    'https://other.example:30443/video',
    'https://bjdownload.pan.wo.cn:30444/video',
  ])
    expect(() => validateUrl(url, undefined, XIFAN_MEDIA_ORIGINS)).toThrow('访问规则');
  expect(() => validateUrl('https://127.0.0.1:30443/video', undefined, ['https://127.0.0.1:30443'])).toThrow(
    '本地',
  );
});
