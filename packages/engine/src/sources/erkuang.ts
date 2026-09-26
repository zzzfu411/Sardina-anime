import * as cheerio from 'cheerio';
import type {
  AnimeCard,
  CatalogInput,
  CatalogPage,
  EpisodeLocator,
  HomeSection,
  SearchInput,
  SearchPage,
  SourceDetail,
  SourceManifest,
  SourceRef,
} from '../../../core/src/types';
import { episodeNumber, inferKind, inferSeason } from '../../../core/src/matching';
import { AppError } from '../errors';
import { validateUrl } from '../http';
import { cleanCard, mediaFormat, type AnimeSource, type ResolvedMedia, type SourceContext } from './types';

export const ERKUANG_BASE = 'https://www.2rk.cc';
const SOURCE = 'erkuang';
const HOSTS = ['www.2rk.cc'];
const UA = 'Mozilla/5.0';
const SLUG = /^[A-Za-z0-9]{1,64}$/;
const EPISODE = /^[1-9]\d{0,3}$/;

const options = (ctx: SourceContext) => ({
  signal: ctx.signal,
  allowedHosts: HOSTS,
  headers: { 'User-Agent': UA, Referer: ERKUANG_BASE + '/' },
});

function checkedSlug(value: string) {
  if (!SLUG.test(value)) throw new AppError('INVALID_LOCATOR', '二矿番剧编号无效', 400);
  return value;
}
function checkedEpisode(value: string) {
  if (!EPISODE.test(value)) throw new AppError('INVALID_LOCATOR', '二矿剧集编号无效', 400);
  return value;
}
function checkedPage(page: number) {
  if (!Number.isInteger(page) || page < 1) throw new AppError('INVALID_PAGE', '页码无效', 400);
  return page;
}

export function erkuangTarget(href: string | undefined): { slug: string; episode: string } | undefined {
  if (!href) return;
  let url: URL;
  try {
    url = new URL(href, ERKUANG_BASE);
  } catch {
    return;
  }
  if (url.hostname !== HOSTS[0] || url.protocol !== 'https:') return;
  const slug = url.pathname.match(/^\/detail\/([A-Za-z0-9]{1,64})$/)?.[1];
  const episode = url.searchParams.get('id') ?? '';
  if (!slug || !EPISODE.test(episode)) return;
  return { slug, episode };
}

function poster(value: string | undefined) {
  if (!value) return;
  try {
    const url = new URL(value, ERKUANG_BASE);
    if (url.protocol === 'https:' && url.hostname === HOSTS[0]) return url.href;
  } catch {
    return;
  }
}

function usable(value: string | undefined) {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text || text === '暂缺' || text === '暂无') return;
  return text;
}

function listCard($: cheerio.CheerioAPI, node: ReturnType<cheerio.CheerioAPI>): AnimeCard | undefined {
  const target = erkuangTarget(node.find('h2 a').attr('href'));
  const title = node.find('h2 span').first().text().trim();
  if (!target || !title) return;
  const date = node
    .find('article.aa > span')
    .map((_i, child) => $(child).text().trim())
    .get()
    .find((text) => /^(?:19|20)\d{2}-\d{2}-\d{2}$/.test(text));
  const remarks = [
    node.find('article.aa > span').eq(1).text().trim(),
    node.find('article.aa span[style]').text().trim(),
  ]
    .filter(Boolean)
    .join(' ');
  const alias = usable(node.attr('data-text'));
  return cleanCard({
    sourceId: SOURCE,
    id: target.slug,
    title,
    poster: poster(node.find('img').attr('src')),
    description: node.find('p').first().text().replace(/\s+/g, ' ').trim(),
    year: date ? Number(date.slice(0, 4)) : undefined,
    kind: inferKind(title) === 'unknown' ? 'tv' : inferKind(title),
    season: inferSeason(title),
    remarks: remarks || undefined,
    ...(alias && alias !== title ? { aliases: [alias] } : {}),
  });
}

export function parseErkuangCards(html: string): AnimeCard[] {
  const $ = cheerio.load(html);
  const cards = new Map<string, AnimeCard>();
  $('article.z').each((_i, node) => {
    const card = listCard($, $(node));
    if (card && !cards.has(card.id)) cards.set(card.id, card);
  });
  return [...cards.values()];
}

export function parseErkuangPage(html: string, page: number): CatalogPage {
  checkedPage(page);
  const totalText = html.match(/共\s*(\d+)\s*(?:条|部)/);
  const total = totalText ? Number(totalText[1]) : undefined;
  const pages = [...html.matchAll(/[?&]p=(\d+)/g)].map((match) => Number(match[1]));
  const pageCount = pages.length ? Math.max(...pages) : undefined;
  if (pageCount !== undefined && page > pageCount)
    throw new AppError('PAGE_NOT_FOUND', '来源未返回所选页码，请返回第一页。', 404);
  const items = parseErkuangCards(html);
  if (!items.length && page === 1 && total !== 0 && !html.includes('搜索结果') && !html.includes('全部动漫'))
    throw new AppError('INVALID_RESPONSE', '二矿目录结构已变化。');
  return {
    items,
    page,
    hasMore: pages.includes(page + 1),
    ...(total !== undefined ? { total } : {}),
    ...(pageCount !== undefined ? { pageCount } : {}),
  };
}

export function parseErkuangHome(html: string): HomeSection[] {
  const $ = cheerio.load(html);
  const airing = $('article.j')
    .map((_i, node) => {
      const link = $(node).find('a').first();
      const target = erkuangTarget(link.attr('href'));
      const title = link.find('img').attr('alt')?.trim() || link.find('span').first().text().trim();
      if (!target || !title) return;
      return cleanCard({
        sourceId: SOURCE,
        id: target.slug,
        title,
        poster: poster(link.find('img').attr('src')),
        kind: inferKind(title) === 'unknown' ? 'tv' : inferKind(title),
        season: inferSeason(title),
        remarks: usable(link.find('span.o').text()),
      });
    })
    .get()
    .filter((card): card is AnimeCard => Boolean(card));
  const recent = $('article.y')
    .map((_i, node) => {
      const link = $(node).find('a').first();
      const target = erkuangTarget(link.attr('href'));
      const title = link.text().trim();
      if (!target || !title) return;
      return cleanCard({
        sourceId: SOURCE,
        id: target.slug,
        title,
        poster: poster(`/video/${target.slug}/index.webp`),
        kind: inferKind(title) === 'unknown' ? 'tv' : inferKind(title),
        season: inferSeason(title),
        remarks: usable($(node).find('span').first().text()),
      });
    })
    .get()
    .filter((card): card is AnimeCard => Boolean(card));
  const sections = [
    { title: '最近更新', items: recent.slice(0, 24) },
    { title: '正在热映', items: airing.slice(0, 24) },
    { title: '推荐动漫', items: parseErkuangCards(html).slice(0, 24) },
  ].filter((section) => section.items.length);
  if (!sections.length) throw new AppError('INVALID_RESPONSE', '二矿首页结构已变化。');
  return sections;
}

export function parseErkuangDetail(html: string, id: string): SourceDetail {
  const slug = checkedSlug(id);
  const $ = cheerio.load(html);
  const title = $('article.ak h2').first().text().trim();
  if (!title) throw new AppError('INVALID_RESPONSE', '二矿详情页面结构已变化。');
  const episodes = $('article.af a')
    .map((_i, node) => {
      const target = erkuangTarget($(node).attr('href'));
      if (!target || target.slug !== slug) return;
      const label = $(node).attr('title')?.trim() || $(node).text().trim();
      if (!label) return;
      return {
        id: target.episode,
        label,
        number: episodeNumber(label),
        kind: /剧场|电影/.test(label) ? ('movie' as const) : ('episode' as const),
        locator: { sourceId: SOURCE, animeId: slug, lineId: '1', episodeId: target.episode },
      };
    })
    .get()
    .filter((episode) => Boolean(episode));
  if (!episodes.length) throw new AppError('INVALID_RESPONSE', '二矿没有返回这一部的选集。');
  const field = (label: string) =>
    usable(
      $('article.ag div')
        .filter((_i, node) => $(node).find('span').first().text().includes(label))
        .first()
        .clone()
        .children('span')
        .first()
        .remove()
        .end()
        .text(),
    );
  const aliases = [field('日文名称'), field('其他名称')].filter((name): name is string => Boolean(name));
  const aired = field('首播时间');
  const status = $('article.ag div')
    .filter((_i, node) => $(node).text().includes('连载状态'))
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();
  return cleanCard({
    sourceId: SOURCE,
    id: slug,
    title,
    poster: poster($('article.ak img').attr('src')),
    description: $('section.ai p').first().text().replace(/\s+/g, ' ').trim(),
    year: aired?.match(/(?:19|20)\d{2}/)?.[0] ? Number(aired.match(/(?:19|20)\d{2}/)![0]) : undefined,
    kind: inferKind(title) === 'unknown' ? 'tv' : inferKind(title),
    season: inferSeason(title),
    remarks: status.replace(/^连载状态:\s*/, '') || undefined,
    ...(aliases.length ? { aliases } : {}),
    lines: [{ id: '1', name: '二矿', episodes }],
  } as SourceDetail) as SourceDetail;
}

export function parseErkuangMedia(html: string, episode: EpisodeLocator): ResolvedMedia {
  const slug = checkedSlug(episode.animeId);
  const episodeId = checkedEpisode(episode.episodeId);
  if (episode.lineId !== '1') throw new AppError('UNSUPPORTED_LINE', '二矿只有一条播放线路。', 400);
  const match = html.match(/loadSource\("([^"]+)"\)/);
  if (!match) throw new AppError('NO_MEDIA', '二矿暂未提供这一集的播放地址。');
  const expected = new RegExp(`^https://www\\.2rk\\.cc/video/${slug}/${episodeId}/[A-Za-z0-9]{8,64}\\.m3u8$`);
  if (!expected.test(match[1])) throw new AppError('UNSUPPORTED_MEDIA', '二矿返回了未登记的播放地址。');
  const url = validateUrl(match[1], HOSTS);
  return {
    url: url.href,
    format: mediaFormat(url.href),
    headers: { 'User-Agent': UA, Referer: ERKUANG_BASE + '/' },
  };
}

export class ErkuangSource implements AnimeSource {
  manifest: SourceManifest = {
    id: SOURCE,
    name: '二矿动漫',
    version: '1.0.0',
    description: 'www.2rk.cc 同站 HLS。只收录站点自己列出的番剧，目录约一百多部',
    allowedHosts: HOSTS,
    capabilities: ['search', 'home', 'play', 'catalog'],
  };

  async search(input: SearchInput, ctx: SourceContext): Promise<SearchPage> {
    const page = checkedPage(input.page);
    const keyword = input.keyword.trim();
    if (keyword.length > 80) throw new AppError('INVALID_FILTER', '搜索词过长', 400);
    const path = keyword
      ? '/search?' + new URLSearchParams({ w: keyword, p: String(page) })
      : '/all?p=' + page;
    return parseErkuangPage(await ctx.http.text(ERKUANG_BASE + path, options(ctx)), page);
  }

  async getCatalog(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage> {
    if (Object.values(input.filters).some(Boolean))
      throw new AppError('INVALID_FILTER', '二矿不支持这个筛选条件', 400);
    const page = checkedPage(input.page);
    return parseErkuangPage(await ctx.http.text(`${ERKUANG_BASE}/all?p=${page}`, options(ctx)), page);
  }

  async getHome(ctx: SourceContext): Promise<HomeSection[]> {
    return parseErkuangHome(await ctx.http.text(ERKUANG_BASE + '/', options(ctx)));
  }

  async getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail> {
    const slug = checkedSlug(ref.id);
    return parseErkuangDetail(await ctx.http.text(`${ERKUANG_BASE}/detail/${slug}?id=1`, options(ctx)), slug);
  }

  async resolve(episode: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia> {
    const slug = checkedSlug(episode.animeId);
    const episodeId = checkedEpisode(episode.episodeId);
    return parseErkuangMedia(
      await ctx.http.text(`${ERKUANG_BASE}/detail/${slug}?id=${episodeId}`, options(ctx)),
      { ...episode, animeId: slug, episodeId },
    );
  }
}
