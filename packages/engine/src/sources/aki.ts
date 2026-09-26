import * as cheerio from 'cheerio';
import JSON5 from 'json5';
import { episodeNumber, inferKind, inferSeason } from '../../../core/src/matching';
import { weekdays, yearFilter } from '../../../core/src/discovery';
import type {
  AnimeCard,
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
import { AppError } from '../errors';
import { cleanCard, mediaFormat, type AnimeSource, type ResolvedMedia, type SourceContext } from './types';

const BASE = 'https://www.akianime.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HOSTS = ['www.akianime.com', 'akianime.com'];
const options = (ctx: SourceContext) => ({
  signal: ctx.signal,
  allowedHosts: HOSTS,
  headers: { 'User-Agent': UA, Referer: `${BASE}/` },
});
const absolute = (value: string) => (value ? new URL(value, BASE).href : '');

export function parseAkiCatalog(input: unknown, page: number): CatalogPage {
  const data = input as {
    code?: unknown;
    list?: Record<string, unknown>[];
    total?: unknown;
    pagecount?: unknown;
  };
  if (!data || ![1, 2].includes(Number(data.code)) || (Number(data.code) === 1 && !Array.isArray(data.list)))
    throw new AppError('INVALID_RESPONSE', 'AkiAnime 目录数据格式已变化');
  const text = (value: unknown) =>
    cheerio
      .load(String(value ?? ''))
      .text()
      .trim();
  const items = (data.list ?? []).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    // Calendar entries link to an episode; directory entries link to a detail page.
    // Both contain the public anime ID. The numeric vod_id is a different identifier.
    let id: string | undefined;
    try {
      const link = new URL(String(value.url ?? ''), BASE);
      if (HOSTS.includes(link.hostname) && ['http:', 'https:'].includes(link.protocol))
        id =
          link.pathname.match(/^\/bgmdetail\/([a-zA-Z0-9_]+)\.html$/)?.[1] ??
          link.pathname.match(/^\/bgmplay\/([a-zA-Z0-9_]+)-\d+-\d+\.html$/)?.[1];
    } catch {}
    const title = text(value.vod_name);
    if (!id || !title) return [];
    const year = Number(value.vod_year);
    return [
      cleanCard({
        sourceId: 'aki',
        id,
        title,
        kind: inferKind(title),
        season: inferSeason(title),
        poster: absolute(String(value.vod_pic ?? '')),
        remarks: text(value.vod_remarks),
        description: text(value.vod_blurb).slice(0, 5000),
        year: year >= 1900 && year <= 2200 ? year : undefined,
      }),
    ];
  });
  if (data.list?.length && !items.length)
    throw new AppError('INVALID_RESPONSE', 'AkiAnime 目录缺少有效番剧编号');
  const total = Number(data.total),
    count = Number(data.pagecount);
  return {
    items,
    page,
    hasMore: Number.isInteger(count) ? page < count : false,
    total: Number.isInteger(total) && total >= 0 ? total : undefined,
    pageCount: Number.isInteger(count) && count >= 0 ? count : undefined,
  };
}

// Extract a JSON literal without evaluating any script from the remote page.
export function jsonAssignment(text: string, name: string): Record<string, any> | undefined {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${safe}\\s*=\\s*`).exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  if (text[start] !== '{') return undefined;
  let depth = 0,
    quote = '',
    escaped = false,
    lineComment = false,
    blockComment = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && text[i + 1] === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
    } else if (c === '/' && text[i + 1] === '/') {
      lineComment = true;
      i++;
    } else if (c === '/' && text[i + 1] === '*') {
      blockComment = true;
      i++;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON5.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function parseAkiCards(html: string): AnimeCard[] {
  const $ = cheerio.load(html);
  const cards = new Map<string, AnimeCard>();
  $('a[href*="/bgmdetail/"]').each((_index, element) => {
    const a = $(element);
    const id = a.attr('href')?.match(/\/bgmdetail\/([^/]+)\.html/)?.[1];
    if (!id) return;
    const container = a.closest('.public-list-box, .search-box, .search-list, .module-search-item, li');
    const scope = container.length ? container : a.parent();
    const image = a.find('img').first().length ? a.find('img').first() : scope.find('img').first();
    const title =
      a.attr('title') ||
      image.attr('alt') ||
      a.find('h3').text().trim() ||
      scope.find('h3').first().text().trim() ||
      a.text().trim();
    if (!title || title.length > 200 || /立即播放|查看详情/.test(title)) return;
    const poster =
      image.attr('data-src') || image.attr('data-original') || image.attr('src') || a.attr('data-src') || '';
    const current = cards.get(id);
    const remarks = scope
      .find('.public-list-prb, .slide-info-remarks, .module-item-note, .pack-prb')
      .first()
      .text()
      .trim();
    cards.set(
      id,
      cleanCard({
        sourceId: 'aki',
        id,
        title: current?.title || title,
        kind: inferKind(title),
        season: inferSeason(title),
        poster: absolute(poster) || current?.poster,
        remarks: remarks || current?.remarks,
      }),
    );
  });
  return [...cards.values()];
}

export function parseAkiDetail(html: string, id: string): SourceDetail {
  const $ = cheerio.load(html);
  const title =
    $('.detail-info h3').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    '';
  if (!title) throw new AppError('INVALID_RESPONSE', 'AkiAnime 详情页面结构已变化');
  const poster =
    $('.detail-pic img').attr('data-src') ||
    $('.detail-pic img').attr('src') ||
    $('img[data-src^="/upload/"]').first().attr('data-src') ||
    '';
  const description =
    $('.check').first().text().trim() ||
    $('.juqing').first().text().trim() ||
    $('meta[property="og:description"]').attr('content') ||
    '';
  const year =
    $('.slide-info')
      .text()
      .match(/(?:19|20)\d{2}/)?.[0] || html.match(/\/bgmsearch\/-+((?:19|20)\d{2})\.html/)?.[1];
  const names = $('.anthology-tab .swiper-slide, .anthology-tab a, .detail-play .swiper-slide')
    .map((_i, el) => $(el).clone().children().remove().end().text().trim())
    .get()
    .filter(Boolean);
  const groups = new Map<string, SourceDetail['lines'][number]>();
  const seen = new Set<string>();
  $('a[href*="/bgmplay/"]').each((_i, el) => {
    const a = $(el);
    const m = a.attr('href')?.match(/\/bgmplay\/([^-]+)-(\d+)-(\d+)\.html/);
    if (!m || m[1] !== id || seen.has(`${m[2]}:${m[3]}`)) return;
    seen.add(`${m[2]}:${m[3]}`);
    if (!groups.has(m[2]))
      groups.set(m[2], {
        id: m[2],
        name:
          names[groups.size]?.replace(/(?:不要相信|请不要|切勿相信|视频里的广告).*$/, '').trim() ||
          `线路 ${m[2]}`,
        episodes: [],
      });
    const label = a.text().trim() || `第 ${m[3]} 集`;
    groups.get(m[2])!.episodes.push({
      id: m[3],
      label,
      number: episodeNumber(label),
      kind: /OVA|特别|特別|总集|SP/i.test(label) ? 'special' : /剧场|电影/.test(label) ? 'movie' : 'episode',
      locator: { sourceId: 'aki', animeId: id, lineId: m[2], episodeId: m[3] },
    });
  });
  for (const line of groups.values()) line.episodes.sort((a, b) => Number(a.id) - Number(b.id));
  return {
    sourceId: 'aki',
    id,
    title,
    poster: absolute(poster),
    description: description.slice(0, 5000),
    year: year ? Number(year) : undefined,
    kind: inferKind(title),
    season: inferSeason(title),
    remarks: $('.slide-info-remarks').first().text().trim(),
    lines: [...groups.values()],
  };
}

export class AkiSource implements AnimeSource {
  manifest: SourceManifest = {
    id: 'aki',
    name: 'AkiAnime',
    version: '1.1.0',
    description: '支持超高画三线；个别剧集可能缺少媒体',
    allowedHosts: HOSTS,
    capabilities: ['search', 'home', 'play', 'multiLine', 'catalog', 'schedule'],
    catalogFilters: [
      {
        key: 'genre',
        label: '题材',
        options: [
          { value: '', label: '全部' },
          ...['校园', '恋爱', '异世界', '战斗', '日常', '治愈', '奇幻', '后宫', '冒险', '魔法', '原创'].map(
            (value) => ({ value, label: value === '战斗' ? '热血 / 战斗' : value }),
          ),
        ],
      },
      yearFilter(),
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
    ],
  };

  private async directory(
    path: 'vod' | 'weekday',
    params: Record<string, string>,
    ctx: SourceContext,
  ): Promise<unknown> {
    if (!(await ctx.http.jar.getCookieString(BASE))) await ctx.http.text(BASE + '/', options(ctx));
    const request = () =>
      ctx.http.json(`${BASE}/index.php/ds_api/${path}`, {
        ...options(ctx),
        method: 'POST',
        headers: {
          ...options(ctx).headers,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams(params).toString(),
      });
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'INVALID_RESPONSE') throw error;
      await ctx.http.text(BASE + '/', options(ctx));
      return request();
    }
  }

  async getCatalog(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage> {
    return parseAkiCatalog(
      await this.directory(
        'vod',
        {
          mid: '1',
          tid: '20',
          class: input.filters.genre ?? '',
          year: input.filters.year ?? '',
          by: input.filters.sort || 'time',
          page: String(input.page),
        },
        ctx,
      ),
      input.page,
    );
  }

  async getSchedule(weekday: number, ctx: SourceContext): Promise<ScheduleDay> {
    const result = parseAkiCatalog(
      await this.directory('weekday', { weekday: weekdays[weekday - 1]!.slice(1) }, ctx),
      1,
    );
    return { sourceId: 'aki', weekday, items: result.items, checkedAt: new Date().toISOString() };
  }

  async search(input: SearchInput, ctx: SourceContext): Promise<SearchPage> {
    if (input.page > 1) return { items: [], page: input.page, hasMore: false };
    const path = input.keyword
      ? `/bgmsearch/${[input.keyword, ...Array(13).fill('')].map(encodeURIComponent).join('-')}.html`
      : '/';
    const html = await ctx.http.text(BASE + path, options(ctx));
    return { items: parseAkiCards(html), page: 1, hasMore: false };
  }

  async getHome(ctx: SourceContext): Promise<HomeSection[]> {
    const html = await ctx.http.text(BASE + '/', options(ctx));
    const items = parseAkiCards(html);
    return [{ title: '最近更新', items: items.slice(0, 24) }];
  }

  async getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail> {
    if (!/^[a-zA-Z0-9_]+$/.test(ref.id)) throw new AppError('INVALID_ID', '番剧编号无效', 400);
    const detail = parseAkiDetail(
      await ctx.http.text(`${BASE}/bgmdetail/${ref.id}.html`, options(ctx)),
      ref.id,
    );
    // Only YDY / 超高画三线 has completed the public-parser playback validation.
    // Legacy direct-HLS and embedded-browser routes remain research material.
    return { ...detail, lines: detail.lines.filter((line) => line.name.includes('超高画三线')) };
  }

  async resolve(episode: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia> {
    if (
      !/^[a-zA-Z0-9_]+$/.test(episode.animeId) ||
      !/^\d+$/.test(episode.lineId) ||
      !/^\d+$/.test(episode.episodeId)
    )
      throw new AppError('INVALID_ID', '剧集编号无效', 400);
    const page = `${BASE}/bgmplay/${episode.animeId}-${episode.lineId}-${episode.episodeId}.html`;
    const html = await ctx.http.text(page, options(ctx));
    const data = jsonAssignment(html, 'player_aaaa');
    if (!data?.url || typeof data.url !== 'string')
      throw new AppError('NO_MEDIA', '这一线路没有提供可解析的播放信息');
    if (data.from !== 'YDY') throw new AppError('UNSUPPORTED_LINE', '首版支持超高画三线，请重新选择线路');
    let url = data.url;
    try {
      if (String(data.encrypt) === '1') url = decodeURIComponent(url);
      else if (String(data.encrypt) === '2')
        url = decodeURIComponent(Buffer.from(url, 'base64').toString('utf8'));
    } catch {
      throw new AppError('INVALID_RESPONSE', '这一线路的播放信息已变化');
    }
    if (/^https?:\/\//i.test(url) && /\.(?:m3u8|mp4)(?:[?#]|$)/i.test(url)) {
      return { url, format: mediaFormat(url), headers: { 'User-Agent': UA, Referer: BASE + '/' } };
    }
    // Public static parser pages may expose an ordinary media URL. Never execute page JS.
    const configText = await ctx.http.text(`${BASE}/static/js/playerconfig.js`, options(ctx));
    const config = jsonAssignment(configText, 'player_list');
    const prefix = config?.[String(data.from)]?.parse;
    const allowedParsers = [
      'aniplayer.xn--gmqr9gevarqk8t.cn',
      'webplayer.aki01a1.top',
      'player.xn--gmqr9gevarqk8t.cn',
    ];
    if (typeof prefix !== 'string' || !prefix.startsWith('https:'))
      throw new AppError('UNSUPPORTED_LINE', '这一线路需要页面播放器，请尝试其他线路');
    const parserPage = prefix + encodeURIComponent(url);
    const parserOptions = {
      signal: ctx.signal,
      allowedHosts: allowedParsers,
      headers: { 'User-Agent': UA, Referer: page },
    };
    const parserHtml = await ctx.http.text(parserPage, parserOptions);
    const parsed = jsonAssignment(parserHtml, 'config');
    if (
      parsed?.url &&
      typeof parsed.url === 'string' &&
      parsed.key !== undefined &&
      parsed.time !== undefined
    ) {
      const result = await ctx.http.json<{ code?: number | string; url?: string }>(
        new URL('api_config.php', parserPage).href,
        {
          ...parserOptions,
          method: 'POST',
          headers: {
            ...parserOptions.headers,
            Referer: parserPage,
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({
            url: parsed.url,
            key: String(parsed.key),
            time: String(parsed.time),
            title: '',
          }).toString(),
        },
      );
      if (String(result.code) === '200' && result.url?.startsWith('http'))
        return { url: result.url, format: mediaFormat(result.url), headers: { 'User-Agent': UA } };
      const code = /^\d{1,3}$/.test(String(result.code)) ? `（状态 ${result.code}）` : '';
      throw new AppError('NO_MEDIA', `来源解析服务暂未提供这一集的媒体${code}，请换源观看`);
    }
    throw new AppError('UNSUPPORTED_LINE', '这一线路需要页面播放器，请尝试其他线路');
  }
}
