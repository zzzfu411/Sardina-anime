import { afterEach, expect, it, vi } from 'vitest';
import { AkiSource } from '../packages/engine/src/sources/aki';
import { HttpClient } from '../packages/engine/src/http';
import { decodeAniMedia } from '../packages/engine/src/sources/anich';

afterEach(() => vi.restoreAllMocks());
it('opens only the Aki playback route covered by validation', async () => {
  const http = new HttpClient();
  vi.spyOn(http, 'text').mockResolvedValue(
    '<h1>测试番剧</h1><div class="anthology-tab"><a>超高画三线</a><a>中画-</a></div><a href="/bgmplay/abc-5-1.html">第1话</a><a href="/bgmplay/abc-1-1.html">第1话</a>',
  );
  const result = await new AkiSource().getDetail({ sourceId: 'aki', id: 'abc' }, { http });
  expect(result.lines.map((line) => line.id)).toEqual(['5']);
});
it('classifies Aki status 100 as missing upstream media, not a browser requirement', async () => {
  const http = new HttpClient();
  vi.spyOn(http, 'text')
    .mockResolvedValueOnce('var player_aaaa={url:"fixture-token",encrypt:0,from:"YDY"};')
    .mockResolvedValueOnce('player_list={YDY:{parse:"https://aniplayer.xn--gmqr9gevarqk8t.cn/?url="}};')
    .mockResolvedValueOnce('var config={url:"fixture-token",key:"fixture-key",time:123,};');
  vi.spyOn(http, 'json').mockResolvedValue({ code: '100', msg: 'missing' });
  await expect(
    new AkiSource().resolve({ sourceId: 'aki', animeId: 'abc', lineId: '1', episodeId: '1' }, { http }),
  ).rejects.toMatchObject({ code: 'NO_MEDIA' });
});
it('refuses old embedded-player routes even when supplied a saved locator', async () => {
  const http = new HttpClient();
  vi.spyOn(http, 'text').mockResolvedValue(
    'var player_aaaa={url:"https://media.example/legacy.m3u8",encrypt:0,from:"other"};',
  );
  await expect(
    new AkiSource().resolve({ sourceId: 'aki', animeId: 'abc', lineId: '2', episodeId: '1' }, { http }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_LINE' });
});
it('decodes AniCh obfuscated media data without treating the locator as a URL', () => {
  const url = 'https://cdn.example/video.mp4';
  const encoded = Buffer.from(url).toString('base64url');
  const bytes = Buffer.from(encoded.slice(0, 3) + 'X' + encoded.slice(3));
  const nested = Buffer.concat([
    Buffer.from([10, bytes.length]),
    bytes,
    Buffer.from([42, 3]),
    Buffer.from('cdn'),
  ]);
  const envelope = Buffer.concat([Buffer.from([10, nested.length]), nested]);
  expect(decodeAniMedia(envelope)).toEqual([{ url, slug: 'cdn', format: 'mp4' }]);
});
