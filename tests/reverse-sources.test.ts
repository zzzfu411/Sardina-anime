import { createCipheriv } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpClient } from '../packages/engine/src/http';
import {
  decodeGugu,
  encryptGugu,
  GuguSource,
  guguCards,
  parseGuguDetail,
  parseGuguMedia,
} from '../packages/engine/src/sources/gugu';
import {
  decodeLedou,
  LedouSource,
  ledouCards,
  parseLedouDetail,
  parseLedouMedia,
} from '../packages/engine/src/sources/ledou';
import { nextPageExists } from '../packages/engine/src/sources/api-utils';

afterEach(() => vi.restoreAllMocks());
const guguEnvelope = (data: unknown) => ({ code: 1, data: encryptGugu(JSON.stringify(data)) });
const guguDetail = {
  vod: { vod_id: 123, type_id: 6, vod_name: '示例 &amp; 动画', vod_year: '2024', vod_points_play: 0 },
  vod_play_list: [
    {
      player_info: { show: '公开线路', parse: 'parser-code' },
      urls: [
        { from: 'yunjie', nid: 1, name: '第12.5集', url: 'opaque-episode', token: 'transient-token' },
        { from: 'yunjie', nid: 2, name: 'SP', url: 'opaque-special' },
        { from: 'yunjie', nid: 2, name: '重复', url: 'duplicate' },
      ],
    },
  ],
};
const ledouDetail = {
  videoId: 123,
  videoName: '示例',
  typeName: '动漫',
  year: '2023',
  playUrlList: [
    { ji: 300, name: '第1集' },
    { ji: 302, name: '第12.5集' },
    { ji: 303, name: 'SP' },
  ],
};
function ledouEnvelope(data: unknown) {
  const nonce = Buffer.alloc(12, 7);
  const c = createCipheriv('aes-256-gcm', Buffer.from('qvn1u7FCfu981olp9ploF7VHVS8Dxih7'), nonce);
  return Buffer.concat([nonce, c.update(JSON.stringify(data)), c.final(), c.getAuthTag()]).toString('base64');
}

it('decodes public API envelopes and rejects corrupted data and access failures', () => {
  expect(decodeGugu(guguEnvelope({ search_list: [] }))).toEqual({ search_list: [] });
  expect(() => decodeGugu({ code: 1, data: 'invalid data' })).toThrow('无法解码');
  expect(() => decodeGugu({ code: 403, data: 'not-authorized' })).toThrow('允许访问');
  const encoded = ledouEnvelope(ledouDetail);
  expect(decodeLedou('\uFEFF' + encoded)).toEqual(ledouDetail);
  const bad = Buffer.from(encoded, 'base64');
  bad[15] ^= 1;
  expect(() => decodeLedou(bad.toString('base64'))).toThrow('无法解码');
  expect(() => decodeLedou('AA==')).toThrow('无法解码');
});

it('does not mix live action into anime lists or fabricate metadata', () => {
  expect(
    guguCards([
      { vod_id: 1, vod_name: '动画' },
      { vod_id: 2, vod_name: '特摄', type_id: 23 },
    ]),
  ).toMatchObject([{ id: '1', kind: 'unknown' }]);
  const rows = [
    { videoId: 1, videoName: '无类型' },
    { videoId: 2, videoName: '电影', typeName: '电影' },
    { videoId: 3, videoName: '动画', typeName: '动漫' },
  ];
  expect(ledouCards(rows).map((c) => c.id)).toEqual(['3']);
  expect(ledouCards(rows, true).map((c) => c.id)).toEqual(['1', '3']);
  expect(ledouCards(rows, true)[0].year).toBeUndefined();
  expect(() => ledouCards({ items: [] })).toThrow('有效列表');
});

it('uses stable line and episode IDs, preserves decimals and omits playback credentials', () => {
  const g = parseGuguDetail(guguDetail, '123');
  expect(g.title).toBe('示例 & 动画');
  expect(g.lines[0].episodes).toHaveLength(2);
  expect(g.lines[0].episodes[0]).toMatchObject({
    number: 12.5,
    locator: { animeId: '123', lineId: 'yunjie', episodeId: '1' },
  });
  expect(JSON.stringify(g)).not.toContain('transient-token');
  expect(JSON.stringify(g)).not.toContain('opaque-episode');
  const l = parseLedouDetail(ledouDetail, '123');
  expect(l.lines[0].episodes.map((ep) => [ep.id, ep.number])).toEqual([
    ['300', 1],
    ['302', 12.5],
    ['303', null],
  ]);
  expect(l.lines[0].episodes[2].kind).toBe('special');
});

it('rejects mismatched detail IDs, paid access and invalid locators', () => {
  expect(() => parseGuguDetail(guguDetail, '124')).toThrow('不匹配');
  expect(() =>
    parseGuguDetail({ ...guguDetail, vod: { ...guguDetail.vod, vod_points_play: 1 } }, '123'),
  ).toThrow('授权');
  expect(() => parseGuguDetail(guguDetail, '../123')).toThrow('编号无效');
  expect(() => parseLedouDetail(ledouDetail, '124')).toThrow('不匹配');
  expect(() => parseLedouDetail({ ...ledouDetail, playUrlList: [] }, '123')).toThrow('选集');
});

it('validates returned media and does not accept local targets or empty success responses', () => {
  expect(parseGuguMedia({ json: JSON.stringify({ url: 'https://cdn.example/video' }) })).toMatchObject({
    format: 'auto',
  });
  expect(
    parseLedouMedia({ code: 0, data: { code: 0, url: 'https://cdn.example/index.m3u8' } }),
  ).toMatchObject({ format: 'hls' });
  expect(() => parseGuguMedia({ json: { url: 'http://127.0.0.1/private' } })).toThrow('本地');
  expect(() => parseLedouMedia({ code: 0, data: { url: 'file:///tmp/a' } })).toThrow('访问规则');
  expect(() => parseGuguMedia({ json: {} })).toThrow('暂未提供');
  expect(() => parseGuguMedia({ json: { msg: '点数不足', url: '' } })).toThrow('授权');
  expect(() =>
    parseLedouMedia({ code: 0, data: { code: 401, url: 'https://cdn.example/index.m3u8' } }),
  ).toThrow('访问条件');
});

it('confirms pagination using new IDs on the next response instead of page size', () => {
  expect(nextPageExists(['1'], ['2'])).toBe(true);
  expect(nextPageExists(['1', '2'], ['1', '2'])).toBe(false);
  expect(nextPageExists(['1'], [])).toBe(false);
});

it('looks ahead on search and keeps the requested keyword and cancellation signal', async () => {
  const http = new HttpClient();
  const request = vi
    .spyOn(http, 'json')
    .mockResolvedValueOnce(guguEnvelope({ search_list: [{ vod_id: 1, vod_name: '番剧' }] }))
    .mockResolvedValueOnce(guguEnvelope({ search_list: [] }));
  const signal = new AbortController().signal;
  const result = await new GuguSource().search({ keyword: '葬送&?', page: 1 }, { http, signal });
  expect(result.hasMore).toBe(false);
  const params = new URLSearchParams(request.mock.calls[0][1]?.body);
  expect(params.get('keywords')).toBe('葬送&?');
  expect(new URLSearchParams(request.mock.calls[1][1]?.body).get('page')).toBe('2');
  expect(request.mock.calls[0][1]).toMatchObject({ signal, allowedHosts: ['www.gugu3.com'] });
});

it('recomputes a Ledou array index from the episode ID when the upstream order changes', async () => {
  const http = new HttpClient();
  vi.spyOn(http, 'text').mockResolvedValue(
    ledouEnvelope({
      ...ledouDetail,
      playUrlList: [ledouDetail.playUrlList[2], ledouDetail.playUrlList[0], ledouDetail.playUrlList[1]],
    }),
  );
  const request = vi
    .spyOn(http, 'json')
    .mockResolvedValueOnce({ code: 0, data: { newDeviceCode: 'session', b: 'credential' } })
    .mockResolvedValueOnce({ code: 0, data: { code: 0, url: 'https://cdn.example/master.m3u8' } });
  const source = new LedouSource();
  await source.resolve({ sourceId: 'ledou', animeId: '123', lineId: 'main', episodeId: '302' }, { http });
  const url = new URL(request.mock.calls[1][0]);
  expect(url.searchParams.get('ji')).toBe('302');
  expect(url.searchParams.get('jiIndex')).toBe('2');
  expect(url.searchParams.get('b')).toBe('credential');
  await expect(
    source.resolve({ sourceId: 'ledou', animeId: '123', lineId: 'main', episodeId: '999' }, { http }),
  ).rejects.toThrow('选集已变化');
  expect(request).toHaveBeenCalledTimes(2);
});

it('rejects unsupported filters before requesting the upstream', async () => {
  const http = new HttpClient();
  const request = vi.spyOn(http, 'json');
  await expect(
    new GuguSource().getCatalog({ page: 1, filters: { channel: '23' } }, { http }),
  ).rejects.toThrow('筛选条件');
  await expect(
    new LedouSource().getCatalog({ page: 1, filters: { year: '2029' } }, { http }),
  ).rejects.toThrow('筛选条件');
  expect(request).not.toHaveBeenCalled();
});

it('keeps mixed search pagination even if one page contains no anime', async () => {
  const http = new HttpClient();
  vi.spyOn(http, 'json')
    .mockResolvedValueOnce([{ videoId: 1, videoName: '电影', typeName: '电影' }])
    .mockResolvedValueOnce([{ videoId: 2, videoName: '番剧', typeName: '动漫' }]);
  expect(await new LedouSource().search({ keyword: '测试', page: 1 }, { http })).toEqual({
    items: [],
    page: 1,
    hasMore: true,
  });
});
