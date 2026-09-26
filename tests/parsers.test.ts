import { describe, expect, it } from 'vitest';
import { decodeFields } from '../packages/engine/src/sources/protobuf';
import {
  decodeAniCards,
  decodeAniEpisodes,
  decodeAniMedia,
  decodeAniPage,
} from '../packages/engine/src/sources/anich';
import { jsonAssignment, parseAkiCards, parseAkiDetail } from '../packages/engine/src/sources/aki';
import { rewriteHls } from '../packages/engine/src/hls';

describe('AniCh binary responses', () => {
  it('keeps actual absolute episode numbers instead of inventing episode one', () => {
    const bytes = Buffer.from('0a070801104e4201410a070801104e4201410a070800104f420142', 'hex');
    expect(decodeAniEpisodes(bytes, '38493')).toMatchObject([
      { id: '78', number: 78, locator: { animeId: '38493', episodeId: '78' } },
    ]);
  });
  it('decodes catalog records and tolerates empty responses', () => {
    expect(decodeAniCards(Buffer.from('0a0908c102120454657374', 'hex'))).toMatchObject([
      { id: '321', title: 'Test' },
    ]);
    expect(decodeAniEpisodes(new Uint8Array(), 'x')).toEqual([]);
    expect(decodeAniMedia(new Uint8Array())).toEqual([]);
  });
  it.each(['0a08ffff', '0800ff', '00', '0b', '08ffffffffffffffffffff01'])(
    'rejects damaged protobuf %s',
    (hex) => expect(() => decodeFields(Buffer.from(hex, 'hex'))).toThrow(),
  );
  it('handles the field limit without quadratic copying and still rejects excess fields', () => {
    const bytes = Buffer.alloc(200_000);
    for (let i = 0; i < bytes.length; i += 2) bytes[i] = 0x0a;
    const started = performance.now();
    expect(decodeAniPage(bytes, 1)).toMatchObject({ items: [], page: 1, hasMore: false });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(() => decodeFields(Buffer.concat([bytes, Buffer.from([0x0a, 0])]))).toThrow();
  });
});

describe('Aki static page adapters', () => {
  const html = `<h1>星空放映室 第二季</h1><div class="detail-pic"><img data-src="/poster.jpg"></div><div class="slide-info">2026</div>
    <div class="anthology-tab"><a>推荐线路</a><a>备用</a></div><a href="/bgmplay/abc-1-1.html">第十二话</a><a href="/bgmplay/abc-1-2.html">第12.5集</a><a href="/bgmplay/abc-2-1.html">SP</a>`;
  it('extracts relative media references, original labels and multiple lines', () => {
    const value = parseAkiDetail(html, 'abc');
    expect(value.poster).toBe('https://www.akianime.com/poster.jpg');
    expect(value.season).toBe(2);
    expect(value.year).toBe(2026);
    expect(value.lines.map((l) => l.name)).toEqual(['推荐线路', '备用']);
    expect(value.lines[0].episodes.map((e) => e.number)).toEqual([12, 12.5]);
    expect(value.lines[1].episodes[0]).toMatchObject({ number: null, kind: 'special' });
  });
  it('deduplicates search links and detects detail layout changes', () => {
    expect(
      parseAkiCards(
        '<li><a href="/bgmdetail/abc.html"><img alt="星空" data-src="/a.jpg"></a><a href="/bgmdetail/abc.html">星空</a></li>',
      ),
    ).toHaveLength(1);
    expect(parseAkiCards('<p>暂无结果</p>')).toEqual([]);
    expect(() => parseAkiDetail('<p>changed markup</p>', 'x')).toThrow('页面结构已变化');
  });
  it('parses data literals with trailing commas, quotes and braces without executing code', () => {
    expect(
      jsonAssignment(
        `var config = {url: 'https://example/a}b', key: 'a', /* } */ time: 1, }; evil();`,
        'config',
      ),
    ).toEqual({ url: 'https://example/a}b', key: 'a', time: 1 });
    expect(jsonAssignment('player_aaaa={"url": "abc\\\"}xyz", "encrypt": 2}', 'player_aaaa')?.encrypt).toBe(
      2,
    );
    expect(jsonAssignment('config = {url: fetch("https://bad.example")}', 'config')).toBeUndefined();
    expect(jsonAssignment('config = notJson', 'config')).toBeUndefined();
  });
});

describe('HLS resource registration', () => {
  it('rewrites master playlists, keys, initialization maps, subtitles and LL-HLS attributes', () => {
    const urls: string[] = [];
    const input = `#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="zh,中文",URI="subs/vtt.m3u8?lang=zh"\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\nvariants/main.m3u8?token=a%2Fb\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin?k=1",IV=0x00000000000000000000000000000001\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"\n#EXT-X-PART:DURATION=0.5,URI="part.m4s"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST`;
    const rewritten = rewriteHls(input, 'https://cdn.example/redirected/show/index.m3u8?session=x', (url) => {
      urls.push(url);
      return '/local/' + urls.length;
    });
    expect(urls).toEqual([
      'https://cdn.example/redirected/show/subs/vtt.m3u8?lang=zh',
      'https://cdn.example/redirected/show/variants/main.m3u8?token=a%2Fb',
      'https://cdn.example/redirected/key.bin?k=1',
      'https://cdn.example/redirected/show/init.mp4',
      'https://cdn.example/redirected/show/part.m4s',
      'https://cdn.example/redirected/show/next.m4s',
      'https://cdn.example/redirected/show/segment.ts',
    ]);
    expect(rewritten).toContain('NAME="zh,中文",URI="/local/1"');
    expect(rewritten).toContain('BYTERANGE="720@0"');
    expect(rewritten).not.toContain('https://');
  });
  it('rejects invalid, variable-based and non-HTTP playlists', () => {
    expect(() => rewriteHls('<html>error</html>', 'https://a.example', (x) => x)).toThrow();
    expect(() => rewriteHls('#EXTM3U\n{$host}/x.ts', 'https://a.example', (x) => x)).toThrow('变量');
    expect(() => rewriteHls('#EXTM3U\nfile:///etc/passwd', 'https://a.example', (x) => x)).toThrow();
  });
});
