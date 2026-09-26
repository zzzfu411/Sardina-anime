import { expect, it, vi, afterEach } from 'vitest';
import {
  ErkuangSource,
  parseErkuangDetail,
  parseErkuangHome,
  parseErkuangMedia,
  parseErkuangPage,
} from '../packages/engine/src/sources/erkuang';
import { HttpClient } from '../packages/engine/src/http';

afterEach(() => vi.restoreAllMocks());

const list = `<article class="z" data-text="Frieren"><section class="ac"><a href="/detail/fulilian?id=1"><img src="/video/fulilian/index.webp"></a></section><article class="aa"><h2><a href="/detail/fulilian?id=1"><span>葬送的芙莉莲</span></a></h2><span>2023-09-29</span><span>28集</span><span style="color:#f31">已完结</span><p>精灵魔法使。</p></article></article>`;
const pager = (page: number, max: number) =>
  `<section>共 53 条数据</section>` +
  Array.from({ length: max }, (_v, i) => `<a href="/search?w=%E7%9A%84&p=${i + 1}">${i + 1}</a>`).join('') +
  (page ? '' : '');

it('reads catalog cards, dates and the explicit pager', () => {
  const page = parseErkuangPage(`<main>全部动漫</main>${pager(1, 6)}${list}`, 1);
  expect(page).toMatchObject({ page: 1, hasMore: true, total: 53, pageCount: 6 });
  expect(page.items[0]).toMatchObject({
    sourceId: 'erkuang',
    id: 'fulilian',
    title: '葬送的芙莉莲',
    year: 2023,
    poster: 'https://www.2rk.cc/video/fulilian/index.webp',
    aliases: ['Frieren'],
    remarks: '28集 已完结',
  });
  expect(
    parseErkuangPage(`<main>搜索结果</main>共 0 条数据 <a href="/search?w=none&p=1">1</a>`, 1),
  ).toMatchObject({
    items: [],
    hasMore: false,
    total: 0,
    pageCount: 1,
  });
  expect(() => parseErkuangPage(`共 177 部 <a href="/all?p=18">18</a>`, 99)).toThrow('所选页码');
});

it('keeps homepage sections separate from recommendation cards', () => {
  const html =
    '<article class=j><a href="/detail/airing1?id=1"><img alt="热映" src="/video/airing1/index.webp"><span class=o>已完结</span></a></article>' +
    '<article class=y><a href="/detail/recent1?id=12">最近</a><span>第12话</span></article>' +
    list;
  expect(
    parseErkuangHome(html).map((section) => [section.title, section.items.map((item) => item.id)]),
  ).toEqual([
    ['最近更新', ['recent1']],
    ['正在热映', ['airing1']],
    ['推荐动漫', ['fulilian']],
  ]);
});

it('uses the episode list and ignores related titles', () => {
  const html = `
    <article class=ak><img src="/video/show1/index.webp"><h2>示例</h2><span>共 2 话</span></article>
    <article class=af><ul>
      <li><a href="/detail/show1?id=1" title="第01话">第01话</a></li>
      <li><a href="/detail/other?id=1" title="别的">别的</a></li>
      <li><a href="/detail/show1?id=2" title="第02话">第02话</a></li>
    </ul></article>
    <article class=ag>
      <div><span>日文名称: </span> Example</div>
      <div><span>其他名称: </span> 暂缺</div>
      <div><span>连载状态: </span>已完结<span>(共2集)</span></div>
      <div><span>首播时间: </span> 2024-01-02</div>
    </article>
    <section class=ai><article><p>简介</p></article></section>
    <article class="j"><a href="/detail/related?id=1">相关</a></article>`;
  const detail = parseErkuangDetail(html, 'show1');
  expect(detail).toMatchObject({
    title: '示例',
    year: 2024,
    aliases: ['Example'],
    description: '简介',
    lines: [{ id: '1', episodes: [{ id: '1', number: 1 }, { id: '2' }] }],
  });
  expect(detail.lines[0].episodes).toHaveLength(2);
});

it('accepts only the same-host playlist for the requested episode', () => {
  const locator = { sourceId: 'erkuang', animeId: 'show1', lineId: '1', episodeId: '2' };
  const media = parseErkuangMedia(
    'h.loadSource("https://www.2rk.cc/video/show1/2/abcdef1234567890.m3u8")',
    locator,
  );
  expect(media).toMatchObject({
    format: 'hls',
    url: 'https://www.2rk.cc/video/show1/2/abcdef1234567890.m3u8',
  });
  expect(() =>
    parseErkuangMedia('h.loadSource("https://evil.example/video/show1/2/abcdef1234567890.m3u8")', locator),
  ).toThrow('未登记');
  expect(() =>
    parseErkuangMedia('h.loadSource("https://www.2rk.cc/video/show1/1/abcdef1234567890.m3u8")', locator),
  ).toThrow('未登记');
});

it('requests the search page and stops on a changed document', async () => {
  const http = new HttpClient();
  const request = vi.spyOn(http, 'text').mockResolvedValue('<html></html>');
  await expect(new ErkuangSource().search({ keyword: '葬送', page: 1 }, { http })).rejects.toThrow(
    '目录结构',
  );
  expect(request).toHaveBeenCalledWith(
    'https://www.2rk.cc/search?w=%E8%91%AC%E9%80%81&p=1',
    expect.objectContaining({ allowedHosts: ['www.2rk.cc'] }),
  );
  await expect(new ErkuangSource().getDetail({ sourceId: 'erkuang', id: '../x' }, { http })).rejects.toThrow(
    '编号无效',
  );
});
