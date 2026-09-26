import { expect, it, vi, afterEach } from 'vitest';
import {
  GirigiriSource,
  giriCatalogPath,
  parseGiriCards,
  parseGiriCatalog,
  parseGiriDetail,
  parseGiriMedia,
} from '../packages/engine/src/sources/girigiri';
import { readFileSync } from 'node:fs';
import { HttpClient } from '../packages/engine/src/http';
import { Registry } from '../packages/engine/src/registry';
import { Store } from '../packages/engine/src/store';

afterEach(() => vi.restoreAllMocks());
const tile = (id = '7') =>
  `<article class="public-list-box"><a title="星空 &amp; 海风" href="/GV${id}/"><img data-src="/poster.jpg"></a><a class="time-title" href="/GV${id}/">星空</a><span class="public-list-prb">更新至12集</span><div class="public-list-subtitle">来源简介</div></article>`;
const head = '<title>girigiri</title>';
it('keeps site votes and the unverified 番 display score separate, and does not use a score as update text', () => {
  const html =
    head +
    `<div class="detail-info"><h1 class="slide-info-title">星空</h1><div class="play-score"><div class="fraction">3.8</div><span class="text-site">11,228次评分</span><span class="douban-score"><em class="db">番</em><em class="score">7.1</em></span></div></div>`;
  expect(parseGiriDetail(html, '7').ratings).toEqual([
    { label: 'girigiri 展示分（番）', score: 7.1, origin: 'source' },
    { label: 'girigiri 站内', score: 3.8, total: 11228, origin: 'source' },
  ]);
  const card = parseGiriCards(tile().replace('更新至12集', '<i class="ft4">8.6</i>'))[0];
  expect(card.ratings?.[0].score).toBe(8.6);
  expect(card.remarks).not.toContain('8.6');
  expect(parseGiriDetail(html.replace('3.8', '99').replace('7.1', '0'), '7').ratings).toBeUndefined();
});
it('reads the actual recent-popular homepage block without mixing the weekly schedule into it', async () => {
  const source = new GirigiriSource();
  const http = new HttpClient();
  vi.spyOn(http, 'text').mockResolvedValue(
    head +
      `<div id="week-module-box">${tile('1')}</div><div class="box-width"><div><h4 class="title-h">最近大家在看</h4>${tile('2')}</div></div>`,
  );
  try {
    const sections = await source.getHome({ http });
    expect(sections.map((s) => [s.title, s.items.map((c) => c.id)])).toEqual([
      ['本周番剧', ['1']],
      ['最近大家在看', ['2']],
    ]);
    expect(sections[1].description).toContain('未公开统计周期');
  } finally {
    http.close();
  }
});
const pagination = (page = 1, max = 2) =>
  `<div>共49条数据,当前${page}/${max}页</div><div class="page-info"><a title="下一页">下一页</a></div>`;
const player = (data: Record<string, unknown>) =>
  head + '<script>var player_aaaa=' + JSON.stringify({ points: 0, trysee: 0, ...data }) + '</script>';

it('shares the homepage with all weekdays, but manual refresh and clear still fetch current data', async () => {
  const store = new Store(':memory:');
  const registry = new Registry(store, [new GirigiriSource()]);
  const read = vi
    .spyOn(registry.context('girigiri').http, 'text')
    .mockResolvedValue(
      head +
        `<div id="week-module-box"><section id="week-module-1">${tile()}</section><section id="week-module-3">${tile('3')}</section></div>`,
    );
  try {
    await Promise.all([registry.home('girigiri'), registry.schedule('girigiri', 3)]);
    await registry.schedule('girigiri', 1);
    expect(read).toHaveBeenCalledTimes(1);
    await registry.schedule('girigiri', 3, undefined, true);
    expect(read).toHaveBeenCalledTimes(2);
    registry.clearCache();
    await registry.home('girigiri');
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    registry.close();
    store.close();
  }
});

it('parses public IDs, relative images and descriptions without inventing metadata from filters', () => {
  const cards = parseGiriCards(
    tile() + tile() + tile('9').replaceAll('/GV9/', 'https://foreign.example/GV9/'),
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    id: '7',
    sourceId: 'girigiri',
    title: '星空 & 海风',
    poster: 'https://ani.yeuxark.com/poster.jpg',
    description: '来源简介',
  });
  expect(cards[0].year).toBeUndefined();
});
it('constructs verified quarter, genre, language, year and page positions together', () => {
  const path = giriCatalogPath({
    page: 2,
    filters: {
      channel: '21',
      quarter: '七月',
      genre: '喜剧',
      lang: '日语',
      year: '2024',
      sort: 'score',
      format: 'OVA',
      adaptation: '漫画改',
    },
  });
  expect(decodeURIComponent(path)).toBe('/show/21-七月-score-喜剧-日语----2-漫画改--2024/version/OVA/');
  expect(() => giriCatalogPath({ page: 1, filters: { region: 'fictional' } })).toThrow();
  expect(() => giriCatalogPath({ page: 0, filters: {} })).toThrow();
});
it('accepts a short search page that lists hits without a pager', () => {
  const html =
    head +
    '<div class="search-list"><a href="/GV26879/"><h3 class="slide-info-title">葬送的芙莉莲 第二季</h3></a><img data-src="/p.webp" alt="葬送的芙莉莲 第二季"><span class="slide-info-remarks">已完结</span><span class="slide-info-remarks"><a>2026</a></span></div>';
  expect(parseGiriCatalog(html, 1)).toMatchObject({
    page: 1,
    hasMore: false,
    total: 1,
    pageCount: 1,
    items: [{ id: '26879', title: '葬送的芙莉莲 第二季', year: 2026, remarks: '已完结' }],
  });
});
it('uses the bottom pager rather than inconsistent presentation totals and rejects a clamped page', () => {
  expect(parseGiriCatalog(head + '<div>1 / 86页</div>' + tile() + pagination(), 1)).toMatchObject({
    page: 1,
    hasMore: true,
    total: 49,
    pageCount: 2,
  });
  expect(parseGiriCatalog(head + tile() + pagination(2), 2).hasMore).toBe(false);
  expect(() => parseGiriCatalog(head + tile() + pagination(), 2)).toThrow('所选页码');
  expect(() => parseGiriCatalog(head + tile(), 1)).toThrow('分页信息');
  expect(parseGiriCatalog(head + '<body>没有找到相关番剧</body>', 1)).toMatchObject({
    items: [],
    hasMore: false,
    total: 0,
  });
});
it('requests user verification without fetching or solving a picture automatically', async () => {
  const http = new HttpClient();
  const read = vi
    .spyOn(http, 'text')
    .mockResolvedValue(head + '<input name="verify"><img class="ds-verify-img">');
  const bytes = vi.spyOn(http, 'bytes');
  const submit = vi.spyOn(http, 'json');
  try {
    await expect(new GirigiriSource().search({ page: 1, keyword: '星空' }, { http })).rejects.toMatchObject({
      code: 'CAPTCHA_REQUIRED',
    });
    expect(read).toHaveBeenCalledOnce();
    expect(bytes).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  } finally {
    http.close();
  }
});
it('forwards only a bounded raster picture and rejects an HTML error response', async () => {
  const http = new HttpClient();
  const png = readFileSync(new URL('./fixtures/girigiri-3572.png', import.meta.url));
  const read = vi.spyOn(http, 'bytes').mockResolvedValue({ body: png, url: '', contentType: 'text/html' });
  try {
    expect(await new GirigiriSource().getSearchCaptcha({ http })).toEqual({
      body: png,
      contentType: 'image/png',
    });
    expect(read.mock.calls[0][2]).toBe(256 * 1024);
    read.mockResolvedValue({ body: Buffer.from('<html>failed</html>'), url: '', contentType: 'image/png' });
    await expect(new GirigiriSource().getSearchCaptcha({ http })).rejects.toMatchObject({
      code: 'INVALID_CAPTCHA',
    });
  } finally {
    http.close();
  }
});
it('submits exactly the user code once and reports an incorrect code', async () => {
  const http = new HttpClient();
  const submit = vi.spyOn(http, 'json').mockResolvedValue({ code: 1 });
  const source = new GirigiriSource();
  try {
    await source.submitSearchCaptcha('3572', { http });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]).toMatchObject([
      'https://ani.yeuxark.com/index.php/ajax/verify_check?type=search&verify=3572',
      { method: 'POST' },
    ]);
    await expect(source.submitSearchCaptcha('12&foo=x', { http })).rejects.toMatchObject({
      code: 'INVALID_CAPTCHA_CODE',
    });
    expect(submit).toHaveBeenCalledOnce();
    submit.mockResolvedValue({ code: 0, msg: 'untrusted upstream text' });
    await expect(source.submitSearchCaptcha('0000', { http })).rejects.toMatchObject({
      code: 'CAPTCHA_INCORRECT',
    });
  } finally {
    http.close();
  }
});
it('keeps actual line numbers, labels and episode identities and excludes another anime', () => {
  const html =
    head +
    `<div class="detail-info"><h3 class="slide-info-title">星空 第二季</h3><div class="slide-info-type">日番</div><span class="slide-info-remarks">完结</span><span class="slide-info-remarks"><a>2024</a></span></div><div class="detail-pic"><img data-src="/p.jpg"></div><div class="check"><div id="height_limit">剧情</div></div><div class="anthology-tab"><a class="swiper-slide"><i></i>繁中<span>2</span></a><a class="swiper-slide">简中<span>1</span></a></div><a href="/playGV7-1-1/">第十二话</a><a href="/playGV7-1-2/">12.5</a><a href="/playGV7-1-2/">12.5</a><a href="/playGV7-2-1/">SP</a><a href="/playGV8-1-1/">01</a>`;
  const data = parseGiriDetail(html, '7');
  expect(data).toMatchObject({
    title: '星空 第二季',
    year: 2024,
    season: 2,
    kind: 'tv',
    description: '剧情',
  });
  expect(data.lines.map((l) => l.name)).toEqual(['繁中', '简中']);
  expect(data.lines[0].episodes.map((e) => e.number)).toEqual([12, 12.5]);
  expect(data.lines[1].episodes[0]).toMatchObject({
    kind: 'special',
    number: null,
    locator: { sourceId: 'girigiri', animeId: '7', lineId: '2', episodeId: '1' },
  });
  expect(() => parseGiriDetail(head + '<p>changed</p>', '7')).toThrow();
});
it.each([0, 1, 2])('decodes public media URL format %i without evaluating source scripts', (encrypt) => {
  const url = 'https://cdn.example/video/a.m3u8?part=1&x=a%2Fb';
  const encoded =
    encrypt === 2
      ? Buffer.from(encodeURIComponent(url)).toString('base64')
      : encrypt === 1
        ? encodeURIComponent(url)
        : url;
  expect(parseGiriMedia(player({ encrypt, url: encoded }))).toMatchObject({
    url,
    format: 'hls',
    headers: { Referer: 'https://ani.yeuxark.com/' },
  });
});
it('rejects protected, unsupported and local media instead of offering an arbitrary proxy', () => {
  expect(() => parseGiriMedia(player({ url: 'https://cdn.example/a.m3u8', points: 10 }))).toThrow('授权');
  expect(() => parseGiriMedia(player({ url: 'http://127.0.0.1/a.m3u8' }))).toThrow('本地');
  expect(() => parseGiriMedia(player({ url: 'https://parser.example/?url=opaque' }))).toThrow('额外解析');
  expect(() => parseGiriMedia(player({ url: '%xx', encrypt: 1 }))).toThrow('编码无效');
  expect(() => parseGiriMedia(head + '<script>player_aaaa={url:fetch("https://example")}</script>')).toThrow(
    '播放地址',
  );
});
it('reads the requested weekday and retries only an empty mirror response once', async () => {
  const http = new HttpClient();
  const read = vi
    .spyOn(http, 'text')
    .mockResolvedValueOnce('<script>/* empty mirror */</script>')
    .mockResolvedValueOnce(
      head +
        `<section id="week-module-1">${tile()}</section><section id="week-module-3">${tile('3')}</section>`,
    );
  expect(await new GirigiriSource().getSchedule(3, { http })).toMatchObject({
    weekday: 3,
    items: [{ id: '3' }],
  });
  expect(read).toHaveBeenCalledTimes(2);
  await expect(new GirigiriSource().getSchedule(9, { http })).rejects.toThrow('星期');
});
