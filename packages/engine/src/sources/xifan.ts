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
import { inferKind, inferSeason } from '../../../core/src/matching';
import { yearFilter } from '../../../core/src/discovery';
import { AppError } from '../errors';
import { sourceRating } from '../ratings';
import { validateUrl } from '../http';
import { cleanCard, mediaFormat, type AnimeSource, type ResolvedMedia, type SourceContext } from './types';
import { array, checkedFilters, checkedPage, numericId, object, plain, text, year } from './api-utils';

const API = 'https://api.xifanacg.com';
const HOSTS = ['api.xifanacg.com'];
// Public website config verified 2026-09-25; this publishable key is not a user token.
const PUBLIC_KEY = 'sb_publishable_OBIVAWACIX6lPXrO98_z24_HcsmalkA';
export const XIFAN_MEDIA_ORIGINS = ['https://bjdownload.pan.wo.cn:30443'];
const PAGE_SIZE = 24;
const options = (ctx: SourceContext) => ({
  signal: ctx.signal,
  allowedHosts: HOSTS,
  method: 'POST' as const,
  headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
});

export function xifanCard(value: unknown): AnimeCard {
  const item = object(value),
    title = plain(item.title);
  if (!title) throw new AppError('INVALID_RESPONSE', '稀饭未返回番剧标题');
  const format = text(item.format);
  const kind =
    format === 'tv'
      ? 'tv'
      : format === 'movie'
        ? 'movie'
        : format === 'ova'
          ? 'ova'
          : format === 'special'
            ? 'special'
            : inferKind(title);
  return cleanCard({
    sourceId: 'xifan',
    id: numericId(item.id),
    title,
    kind,
    poster: text(item.cover_url) || undefined,
    description: plain(item.description) || undefined,
    year: year(item.release_year),
    season: inferSeason(title),
    remarks:
      plain(item.remarks) ||
      (Number(item.current_episodes) > 0 ? `更新至 ${Number(item.current_episodes)} 集` : undefined),
    aliases: text(item.title_original) ? [plain(item.title_original)] : undefined,
    ratings: sourceRating(
      item.bangumi_score,
      'Bangumi · 稀饭收录',
      item.bangumi_rating_total,
      'bangumi-snapshot',
    ),
  });
}
export function parseXifanPage(value: unknown, page: number): CatalogPage {
  checkedPage(page);
  const rows = array(value);
  if (!rows.length) return { items: [], page, hasMore: false };
  const total = Number(object(rows[0]).total_count);
  if (!Number.isSafeInteger(total) || total < rows.length)
    throw new AppError('INVALID_RESPONSE', '稀饭未返回有效分页总数');
  const pageCount = Math.ceil(total / PAGE_SIZE);
  if (page > pageCount) throw new AppError('PAGE_NOT_FOUND', '稀饭未返回所选页码', 404);
  return { items: rows.map(xifanCard), page, total, pageCount, hasMore: page < pageCount };
}
export function parseXifanDetail(value: unknown, id: string): SourceDetail {
  const data = object(value),
    anime = object(data.anime);
  if (text(anime.id) !== numericId(id)) throw new AppError('INVALID_RESPONSE', '稀饭返回了不匹配的番剧');
  if (anime.requires_comprehensive === true)
    throw new AppError('ACCESS_REQUIRED', '此番剧需要稀饭站内账号及考试权限，当前仅接入公开内容');
  const card = xifanCard(anime);
  const lines = array(data.sources)
    .map(object)
    .filter((s) => Number(s.id) === 4 && text(s.code) === 'xfxf1')
    .map((line) => {
      const seen = new Set<string>();
      const episodes = array(line.episodes)
        .map(object)
        .flatMap((ep) => {
          const episodeId = numericId(ep.id),
            number = Number(ep.episode_number);
          if (seen.has(episodeId)) return [];
          if (text(ep.available_at) && Date.parse(text(ep.available_at)) > Date.now()) return [];
          seen.add(episodeId);
          const isMain = text(ep.kind) === 'main';
          const label = `${Number.isFinite(number) && number >= 0 ? `第 ${number} 集` : '特别篇'}${plain(ep.title) ? ` · ${plain(ep.title)}` : ''}`;
          return [
            {
              id: episodeId,
              label,
              number: Number.isFinite(number) && number >= 0 ? number : null,
              kind: isMain ? ('episode' as const) : ('special' as const),
              locator: { sourceId: 'xifan', animeId: id, lineId: text(line.id), episodeId },
            },
          ];
        });
      return { id: text(line.id), name: plain(line.name), episodes };
    })
    .filter((line) => line.episodes.length);
  if (!lines.length)
    throw new AppError('NO_PUBLIC_LINE', '此番剧暂未提供已接入的稀饭公开主线，请尝试其他来源');
  return { ...card, lines };
}
export function parseXifanMedia(value: unknown, episode: EpisodeLocator): ResolvedMedia {
  const data = object(value);
  if (data.ok !== true) {
    const code = text(data.error);
    if (code === 'rate_limited') throw new AppError('ACCESS_REQUIRED', '稀饭暂时限制播放请求，请稍后重试');
    if (/forbidden|unauthenticated|exam|comprehensive/.test(code))
      throw new AppError('ACCESS_REQUIRED', '此稀饭线路需要站内授权，当前仅接入公开播放');
    throw new AppError('NO_MEDIA', '稀饭暂未提供可用媒体，请换源或稍后重试');
  }
  if (text(data.episode_id) !== episode.episodeId || text(data.anime_id) !== episode.animeId)
    throw new AppError('INVALID_RESPONSE', '稀饭签发的播放地址不属于当前剧集');
  const item = array(data.candidates)
    .map(object)
    .find((c) => text(c.source_id) === episode.lineId && text(c.source_code) === 'xfxf1');
  if (!item || !text(item.url)) throw new AppError('NO_MEDIA', '稀饭未返回所选公开线路');
  const url = validateUrl(text(item.url), undefined, XIFAN_MEDIA_ORIGINS).href;
  return {
    url,
    format: mediaFormat(url),
    headers: { 'User-Agent': 'Mozilla/5.0' },
    allowedPortOrigins: XIFAN_MEDIA_ORIGINS,
  };
}
export class XifanSource implements AnimeSource {
  manifest: SourceManifest = {
    id: 'xifan',
    name: '稀饭动漫',
    version: '1.0.1',
    description: '搜索、索引、详情和新番主线 1；整集测试曾中断，需要登录或考试的内容不开放',
    allowedHosts: HOSTS,
    capabilities: ['search', 'catalog', 'home', 'play'],
    catalogFilters: [
      yearFilter(),
      {
        key: 'format',
        label: '类型',
        options: [
          { value: '', label: '全部' },
          { value: 'tv', label: 'TV 动画' },
          { value: 'movie', label: '剧场版' },
          { value: 'ova', label: 'OVA' },
        ],
      },
    ],
  };
  private rpc(name: string, params: Record<string, unknown>, ctx: SourceContext) {
    return ctx.http.json(`${API}/rest/v1/rpc/${name}`, { ...options(ctx), body: JSON.stringify(params) });
  }
  async search(input: SearchInput, ctx: SourceContext): Promise<SearchPage> {
    checkedPage(input.page);
    return parseXifanPage(
      await this.rpc(
        'search_animes',
        {
          search_term: input.keyword,
          page_number: input.page,
          items_per_page: PAGE_SIZE,
          filter_only_published: true,
        },
        ctx,
      ),
      input.page,
    );
  }
  async getCatalog(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage> {
    checkedFilters(this.manifest, input);
    return parseXifanPage(
      await this.rpc(
        'search_animes',
        {
          search_term: '',
          page_number: input.page,
          items_per_page: PAGE_SIZE,
          filter_only_published: true,
          ...(input.filters.year ? { filter_release_year: Number(input.filters.year) } : {}),
          ...(input.filters.format ? { filter_format: input.filters.format } : {}),
        },
        ctx,
      ),
      input.page,
    );
  }
  async getHome(ctx: SourceContext): Promise<HomeSection[]> {
    return [
      {
        title: '最近更新',
        items: array(await this.rpc('get_recently_updated_animes', {}, ctx))
          .slice(0, 24)
          .map(xifanCard),
      },
    ];
  }
  async getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail> {
    return parseXifanDetail(
      await this.rpc('get_anime_detail', { p_id: Number(numericId(ref.id)) }, ctx),
      ref.id,
    );
  }
  async resolve(episode: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia> {
    if (episode.lineId !== '4') throw new AppError('UNSUPPORTED_LINE', '仅接入稀饭新番公开主线 1', 400);
    const detail = await this.getDetail({ sourceId: 'xifan', id: episode.animeId }, ctx);
    if (!detail.lines[0].episodes.some((ep) => ep.id === episode.episodeId))
      throw new AppError('EPISODE_NOT_FOUND', '稀饭选集已变化，请重新打开详情', 404);
    return parseXifanMedia(
      await ctx.http.json(`${API}/functions/v1/issue-web-playback?forceFunctionRegion=ap-southeast-1`, {
        ...options(ctx),
        body: JSON.stringify({
          action: 'fallback',
          episode_id: Number(numericId(episode.episodeId)),
          source_id: 4,
        }),
      }),
      episode,
    );
  }
}
