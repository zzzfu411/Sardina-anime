import * as cheerio from 'cheerio';
import type {
  AnimeCard,
  CatalogFilter,
  CatalogInput,
  CatalogPage,
  EpisodeLocator,
  HomeSection,
  ScheduleDay,
  SearchInput,
  SearchPage,
  SourceDetail,
  SourceManifest,
  SourceRef,
} from '../../../core/src/types';
import { yearFilter } from '../../../core/src/discovery';
import { episodeNumber, inferKind, inferSeason } from '../../../core/src/matching';
import { AppError } from '../errors';
import { sourceRating } from '../ratings';
import { RequestCache } from '../request-cache';
import { validateUrl } from '../http';
import { jsonAssignment } from './aki';
import { getGiriDanmaku, updateGiriAudience } from './giri-danmaku';
import { cleanCard, mediaFormat, type AnimeSource, type ResolvedMedia, type SourceContext } from './types';

export const GIRIGIRI_BASE = 'https://ani.yeuxark.com';
const SOURCE = 'girigiri';
const HOSTS = ['ani.yeuxark.com'];
const UA = 'Mozilla/5.0';
const options = (ctx: SourceContext) => ({
  signal: ctx.signal,
  allowedHosts: HOSTS,
  headers: { 'User-Agent': UA, Referer: GIRIGIRI_BASE + '/' },
});
const choices = (key: string, label: string, values: string[]): CatalogFilter => ({
  key,
  label,
  options: [{ value: '', label: '全部' }, ...values.map((value) => ({ value, label: value }))],
});
const years = yearFilter();
const filters: CatalogFilter[] = [
  {
    key: 'channel',
    label: '分类',
    defaultValue: '2',
    options: [
      { value: '2', label: '日番' },
      { value: '3', label: '美番' },
      { value: '21', label: '剧场版' },
    ],
  },
  choices('genre', '题材', [
    '喜剧',
    '爱情',
    '恐怖',
    '动作',
    '科幻',
    '剧情',
    '战争',
    '奇幻',
    '冒险',
    '悬疑',
    '校园',
    '后宫',
    '热血',
    '运动',
    '职场',
    '百合',
    '乙女',
    '机甲',
    '日常',
    '魔法少女',
    '异世界',
    '爱抖露',
    '音乐',
    '萌',
  ]),
  choices('quarter', '季度', ['一月', '四月', '七月', '十月']),
  {
    ...years,
    options: [
      ...years.options.filter((v) => !v.value || Number(v.value) >= 2001),
      { value: '2000至90年代', label: '2000 至 90 年代' },
    ],
  },
  choices('lang', '语言', ['日语', '国语']),
  choices('format', '形式', ['TV番', '泡面番', 'OVA']),
  choices('adaptation', '改编', ['小说改', '漫画改', '游戏改', '原创']),
  {
    key: 'sort',
    label: '排序',
    defaultValue: 'time',
    options: [
      { value: 'time', label: '最近更新' },
      { value: 'hits', label: '来源热度' },
      { value: 'score', label: '来源评分' },
    ],
  },
];

function checkedId(value: string) {
  if (!/^\d{1,12}$/.test(value)) throw new AppError('INVALID_LOCATOR', 'girigiri 番剧或剧集编号无效', 400);
  return value;
}
function animeId(href: string | undefined): string | undefined {
  if (!href) return;
  try {
    const url = new URL(href, GIRIGIRI_BASE);
    if (!HOSTS.includes(url.hostname) || !['https:', 'http:'].includes(url.protocol)) return;
    return url.pathname.match(/^\/GV(\d{1,12})\/$/)?.[1];
  } catch {
    return;
  }
}
function poster(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value, GIRIGIRI_BASE);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return;
  }
}
export function isGiriVerify(html: string) {
  const $ = cheerio.load(html);
  return $('input[name="verify"],.ds-verify,.mac_verify_img').length > 0;
}

function checkPage(html: string) {
  const $ = cheerio.load(html);
  if (isGiriVerify(html) || /Just a moment|challenge-platform/.test(html))
    throw new AppError('ACCESS_REQUIRED', 'girigiri 站内搜索需要验证码，请通过番剧索引或每周放送查找。');
  if (!$('title').text().trim() && !$('.public-list-box,.detail-info,.search-box').length)
    throw new AppError('INVALID_RESPONSE', 'girigiri 暂时返回了空页面，请刷新重试。');
  return $;
}

export function parseGiriCards(html: string): AnimeCard[] {
  const $ = cheerio.load(html);
  const result = new Map<string, AnimeCard>();
  $('.public-list-box,.search-box,.search-list').each((_i, element) => {
    const scope = $(element),
      links = scope.find('a[href]');
    const link = links.filter((_j, a) => Boolean(animeId($(a).attr('href')))).first();
    const id = animeId(link.attr('href'));
    const image = scope.find('img').first();
    const title = (
      link.attr('title') ||
      image.attr('alt') ||
      scope.find('.time-title,h3').first().text()
    ).trim();
    if (!id || !title || result.has(id)) return;
    const caption = scope.find('.public-list-prb,.module-item-note').first();
    // In movie/score lists this badge is a score, not an episode/update label.
    const ratings = sourceRating(caption.find('i.ft4').text().trim(), 'girigiri 展示分');
    result.set(
      id,
      cleanCard({
        sourceId: SOURCE,
        id,
        title,
        kind: inferKind(title),
        season: inferSeason(title),
        poster: poster(image.attr('data-src') || image.attr('data-original') || image.attr('src')),
        remarks:
          (ratings.length ? '' : caption.text().trim()) ||
          scope.find('.slide-info-remarks').first().text().trim(),
        ...(ratings.length ? { ratings } : {}),
        year:
          Number(
            scope
              .find('.slide-info-remarks a')
              .toArray()
              .map((node) => $(node).text().trim())
              .find((text) => /^(?:19|20)\d{2}$/.test(text)),
          ) || undefined,
        description: scope.find('.public-list-subtitle,.search-info').first().text().trim(),
      }),
    );
  });
  return [...result.values()];
}

export function giriCatalogPath(input: CatalogInput): string {
  const f = input.filters;
  for (const [key, value] of Object.entries(f)) {
    if (!filters.find((item) => item.key === key)?.options.some((option) => option.value === value))
      throw new AppError('INVALID_FILTER', 'girigiri 不支持这个筛选条件', 400);
  }
  if (!Number.isInteger(input.page) || input.page < 1 || input.page > 1000)
    throw new AppError('INVALID_PAGE', '页码无效', 400);
  const parts = [
    f.channel || '2',
    f.quarter || '',
    f.sort || 'time',
    f.genre || '',
    f.lang || '',
    '',
    '',
    '',
    String(input.page),
    f.adaptation || '',
    '',
    f.year || '',
  ];
  return (
    '/show/' +
    parts.map(encodeURIComponent).join('-') +
    '/' +
    (f.format ? 'version/' + encodeURIComponent(f.format) + '/' : '')
  );
}

export function parseGiriCatalog(html: string, page: number): CatalogPage {
  const $ = checkPage(html);
  const items = parseGiriCards(html);
  const pagination = $('.page-info')
    .prev()
    .text()
    .match(/共\s*(\d+)\s*条数据\s*[,，]\s*当前\s*(\d+)\s*\/\s*(\d+)\s*页/);
  if (pagination) {
    if (Number(pagination[2]) !== page)
      throw new AppError('PAGE_NOT_FOUND', '来源未返回所选页码，请返回第一页。', 404);
    return {
      items,
      page,
      total: Number(pagination[1]),
      pageCount: Number(pagination[3]),
      hasMore: page < Number(pagination[3]),
    };
  }
  if (!items.length && !/没有找到|暂无数据|暂无相关|没有相关/.test($('body').text()))
    throw new AppError('INVALID_RESPONSE', 'girigiri 目录结构已变化，请稍后重试。');
  // Short searches omit the pager. Catalog pages always include it.
  if (items.length && !$('.search-list').length)
    throw new AppError('INVALID_RESPONSE', 'girigiri 分页信息缺失，暂时无法确认完整目录。');
  return { items, page, hasMore: false, total: items.length, pageCount: items.length ? 1 : 0 };
}

export function parseGiriDetail(html: string, id: string): SourceDetail {
  checkedId(id);
  const $ = checkPage(html);
  const title = $('.detail-info .slide-info-title').first().text().trim() || $('h1').first().text().trim();
  if (!title) throw new AppError('INVALID_RESPONSE', 'girigiri 详情页面结构已变化。');
  const names = $('.anthology-tab .swiper-slide')
    .map((_i, e) => $(e).clone().children().remove().end().text().trim())
    .get();
  const groups = new Map<string, SourceDetail['lines'][number]>();
  const seen = new Set<string>();
  $('a[href]').each((_i, element) => {
    const a = $(element);
    let link: URL;
    try {
      link = new URL(a.attr('href')!, GIRIGIRI_BASE);
    } catch {
      return;
    }
    if (!HOSTS.includes(link.hostname)) return;
    const match = link.pathname.match(/^\/playGV(\d+)-(\d+)-(\d+)\/$/);
    if (!match || match[1] !== id || seen.has(match[2] + ':' + match[3])) return;
    seen.add(match[2] + ':' + match[3]);
    if (!groups.has(match[2]))
      groups.set(match[2], {
        id: match[2],
        name: names[Number(match[2]) - 1] || '线路 ' + match[2],
        episodes: [],
      });
    const label = a.text().trim() || '第 ' + match[3] + ' 集';
    groups.get(match[2])!.episodes.push({
      id: match[3],
      label,
      number: episodeNumber(label),
      kind: /OVA|OAD|SP|特[别別]|总集/i.test(label)
        ? 'special'
        : /剧场|電影|电影/.test(label)
          ? 'movie'
          : 'episode',
      locator: { sourceId: SOURCE, animeId: id, lineId: match[2], episodeId: match[3] },
    });
  });
  const info = $('.detail-info');
  const year = info
    .find('.slide-info-remarks a')
    .map((_i, e) => $(e).text().trim())
    .get()
    .find((v) => /^(19|20)\d{2}$/.test(v));
  const type = info.find('.slide-info-type').text();
  const aliases = info.find('.slide-info-alias').text().trim();
  const voteText = info.find('.play-score .text-site').text().replaceAll(',', '');
  const votes = voteText.match(/(\d+)\s*次评分/)?.[1];
  const ratings = [
    ...sourceRating(info.find('.douban-score .score').text().trim(), 'girigiri 展示分（番）'),
    ...sourceRating(info.find('.play-score .fraction').text().trim(), 'girigiri 站内', votes),
  ];
  return cleanCard({
    sourceId: SOURCE,
    id,
    title,
    poster: poster($('.detail-pic img').attr('data-src') || $('.detail-pic img').attr('src')),
    description: $('.check #height_limit,.juqing').first().text().trim(),
    year: year ? Number(year) : undefined,
    kind: /剧场|劇場/.test(type) ? 'movie' : /日番|美番/.test(type) ? 'tv' : inferKind(title),
    season: inferSeason(title),
    remarks: info.find('.slide-info-remarks').first().text().trim(),
    ...(aliases ? { aliases: [aliases] } : {}),
    ...(ratings.length ? { ratings } : {}),
    lines: [...groups.values()],
  } as SourceDetail) as SourceDetail;
}

export function parseGiriMedia(html: string): ResolvedMedia {
  checkPage(html);
  const data = jsonAssignment(html, 'player_aaaa');
  if (!data || typeof data.url !== 'string')
    throw new AppError('NO_MEDIA', 'girigiri 暂未提供这一集的播放地址。');
  if (Number(data.points) > 0 || Number(data.trysee) > 0)
    throw new AppError('ACCESS_REQUIRED', '这条线路需要站内授权，当前不能直接播放。');
  if (![0, 1, 2].includes(Number(data.encrypt ?? 0)))
    throw new AppError('UNSUPPORTED_MEDIA', 'girigiri 使用了尚未支持的播放地址格式。');
  let raw = data.url;
  try {
    if (Number(data.encrypt) === 2) raw = Buffer.from(raw, 'base64').toString('utf8');
    if (Number(data.encrypt) > 0) raw = decodeURIComponent(raw);
  } catch {
    throw new AppError('INVALID_RESPONSE', 'girigiri 返回的播放地址编码无效。');
  }
  const url = validateUrl(raw);
  const format = mediaFormat(url.href);
  if (format === 'auto')
    throw new AppError('UNSUPPORTED_MEDIA', '这条 girigiri 线路需要额外解析，请选择其他线路。');
  return { url: url.href, format, headers: { 'User-Agent': UA, Referer: GIRIGIRI_BASE + '/' } };
}

export class GirigiriSource implements AnimeSource {
  private homepage = new RequestCache(1);
  clearCache() {
    this.homepage.clear();
  }
  private snapshot(ctx: SourceContext) {
    return this.homepage.load(
      'home',
      async (signal) => ({
        html: await this.page('/', { ...ctx, signal }),
        checkedAt: new Date().toISOString(),
      }),
      { signal: ctx.signal, refresh: ctx.refresh, ttl: 60_000 },
    );
  }
  manifest: SourceManifest = {
    id: SOURCE,
    name: 'girigiri',
    version: '1.2.0',
    description: 'ani.yeuxark.com；完整索引、周期表、繁中/简中 HLS；搜索遇到验证码时可在应用内手动输入',
    allowedHosts: HOSTS,
    capabilities: ['search', 'home', 'play', 'multiLine', 'catalog', 'schedule', 'danmaku', 'audience'],
    catalogFilters: filters,
  };
  getDanmaku(media: ResolvedMedia, ctx: SourceContext) {
    return getGiriDanmaku(media.url, ctx);
  }
  updateAudience(media: ResolvedMedia, action: 'open' | 'close', ctx: SourceContext) {
    return updateGiriAudience(media.url, action, ctx);
  }
  private async fetchPage(path: string, ctx: SourceContext) {
    const url = GIRIGIRI_BASE + path;
    let html = await ctx.http.text(url, options(ctx));
    // The user's mirror occasionally returns only its own short script with status 200.
    if (html.length < 1000 && !/<(?:html|body|title)\b/i.test(html))
      html = await ctx.http.text(url, options(ctx));
    return html;
  }
  private async page(path: string, ctx: SourceContext) {
    const html = await this.fetchPage(path, ctx);
    checkPage(html);
    return html;
  }
  async getSearchCaptcha(ctx: SourceContext) {
    const { body } = await ctx.http.bytes(
      `${GIRIGIRI_BASE}/index.php/verify/index.html?r=${Math.random()}`,
      options(ctx),
      256 * 1024,
    );
    // Accept raster images only, including servers which incorrectly label PNGs as HTML.
    const contentType = body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      ? 'image/png'
      : body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
        ? 'image/jpeg'
        : /^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'))
          ? 'image/gif'
          : body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP'
            ? 'image/webp'
            : '';
    if (!contentType) throw new AppError('INVALID_CAPTCHA', 'girigiri 未返回有效的验证码图片，请重试。');
    return { body, contentType };
  }
  async submitSearchCaptcha(code: string, ctx: SourceContext) {
    if (!/^\d{4}$/.test(code)) throw new AppError('INVALID_CAPTCHA_CODE', '请输入 4 位数字。', 400);
    const result = await ctx.http.json<{ code?: number | string }>(
      `${GIRIGIRI_BASE}/index.php/ajax/verify_check?type=search&verify=${code}`,
      {
        ...options(ctx),
        method: 'POST',
        headers: { ...options(ctx).headers, 'X-Requested-With': 'XMLHttpRequest' },
      },
    );
    if (Number(result.code) !== 1)
      throw new AppError('CAPTCHA_INCORRECT', '验证码不正确或已失效，请重新输入。', 409);
  }
  async search(input: SearchInput, ctx: SourceContext): Promise<SearchPage> {
    const query = new URLSearchParams({ wd: input.keyword, page: String(input.page) });
    const path = '/search/-------------/?' + query;
    const html = await this.fetchPage(path, ctx);
    if (isGiriVerify(html)) throw new AppError('CAPTCHA_REQUIRED', 'girigiri 搜索需要输入验证码。', 409);
    checkPage(html);
    return parseGiriCatalog(html, input.page);
  }
  async getCatalog(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage> {
    return parseGiriCatalog(await this.page(giriCatalogPath(input), ctx), input.page);
  }
  async getHome(ctx: SourceContext): Promise<HomeSection[]> {
    const $ = cheerio.load((await this.snapshot(ctx)).html);
    const items = parseGiriCards($('#week-module-box').html() || '');
    if (!items.length) throw new AppError('INVALID_RESPONSE', 'girigiri 首页番剧区域已变化。');
    const popular = $('.title-h')
      .filter((_i, node) => $(node).text().trim() === '最近大家在看')
      .first();
    const popularItems = popular.length ? parseGiriCards(popular.closest('.box-width').html() || '') : [];
    return [
      { title: '本周番剧', items: items.slice(0, 30) },
      ...(popularItems.length
        ? [
            {
              title: '最近大家在看',
              items: popularItems.slice(0, 24),
              description: 'girigiri 首页推荐，来源未公开统计周期。',
              catalogFilters: { sort: 'hits' },
            },
          ]
        : []),
    ];
  }
  async getSchedule(weekday: number, ctx: SourceContext): Promise<ScheduleDay> {
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)
      throw new AppError('INVALID_DAY', '星期无效', 400);
    const snapshot = await this.snapshot(ctx);
    const $ = cheerio.load(snapshot.html);
    const area = $('#week-module-' + weekday);
    if (!area.length) throw new AppError('INVALID_RESPONSE', 'girigiri 周期表结构已变化。');
    return {
      sourceId: SOURCE,
      weekday,
      items: parseGiriCards(area.html() || ''),
      checkedAt: snapshot.checkedAt,
    };
  }
  async getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail> {
    return parseGiriDetail(await this.page('/GV' + checkedId(ref.id) + '/', ctx), ref.id);
  }
  async resolve(episode: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia> {
    const path =
      '/playGV' + [episode.animeId, episode.lineId, episode.episodeId].map(checkedId).join('-') + '/';
    return parseGiriMedia(await this.page(path, ctx));
  }
}
