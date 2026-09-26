import { createCipheriv, createDecipheriv } from 'node:crypto';
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
import {
  array,
  checkedFilters,
  checkedPage,
  nextPageExists,
  numericId,
  object,
  plain,
  text,
  uniqueCards,
  year,
} from './api-utils';

const BASE = 'https://www.gugu3.com';
const HOSTS = ['www.gugu3.com'];
// Public client protocol constant; this is not an account credential or a media DRM key.
const KEY = Buffer.from('nKfZ8KX6JTNWRzTD');
const UA = 'okhttp/3.14.9';
const choices = (values: string[]) => values.map((value) => ({ value, label: value || '全部' }));

export function encryptGugu(value: string): string {
  const cipher = createCipheriv('aes-128-cbc', KEY, KEY);
  return Buffer.concat([cipher.update(value), cipher.final()]).toString('base64');
}
export function decodeGugu(value: unknown): Record<string, unknown> {
  const envelope = object(value);
  if (Number(envelope.code) !== 1 || typeof envelope.data !== 'string')
    throw new AppError('ACCESS_REQUIRED', '咕咕接口暂未允许访问，请稍后重试');
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)) throw new Error();
    const cipher = createDecipheriv('aes-128-cbc', KEY, KEY);
    return object(
      JSON.parse(Buffer.concat([cipher.update(envelope.data, 'base64'), cipher.final()]).toString('utf8')),
    );
  } catch {
    throw new AppError('INVALID_RESPONSE', '咕咕响应无法解码，接口可能已变化');
  }
}
export function guguCards(value: unknown, channel?: string): AnimeCard[] {
  return uniqueCards(
    array(value).flatMap((row) => {
      const item = object(row);
      if (!text(item.vod_id) || !plain(item.vod_name)) return [];
      if (item.type_id !== undefined && ![6, 21].includes(Number(item.type_id))) return [];
      const title = plain(item.vod_name);
      return [
        cleanCard({
          sourceId: 'gugu',
          id: numericId(item.vod_id),
          title,
          poster: text(item.vod_pic) || undefined,
          description: plain(item.vod_content || item.vod_blurb) || undefined,
          year: year(item.vod_year),
          season: inferSeason(title),
          kind: String(item.type_id ?? channel) === '21' ? 'movie' : inferKind(title),
          remarks: plain(item.vod_remarks) || undefined,
          aliases: text(item.vod_sub) ? text(item.vod_sub).split(/[,，]/).filter(Boolean) : undefined,
        }),
      ];
    }),
  );
}
function linesOf(data: Record<string, unknown>) {
  return array(data.vod_play_list)
    .map(object)
    .map((line) => {
      const episodes = array(line.urls).map(object);
      const id = text(episodes[0]?.from);
      if (!/^[a-zA-Z0-9_]{1,80}$/.test(id)) throw new AppError('INVALID_RESPONSE', '咕咕播放线路标识已变化');
      return { id, info: object(line.player_info), episodes };
    });
}
function checkAccess(vod: Record<string, unknown>) {
  if (Number(vod.vod_points_play) > 0 || Number(vod.vod_trysee) > 0 || text(vod.vod_pwd_play))
    throw new AppError('ACCESS_REQUIRED', '此番剧需要来源站授权，当前仅接入公开播放内容');
}
export function parseGuguDetail(value: unknown, id: string): SourceDetail {
  numericId(id);
  const data = object(value),
    vod = object(data.vod);
  if (text(vod.vod_id) !== id) throw new AppError('INVALID_RESPONSE', '咕咕返回了不匹配的番剧详情');
  checkAccess(vod);
  const card = guguCards([vod])[0];
  if (!card) throw new AppError('UNSUPPORTED_CATEGORY', '这个条目不属于已接入的动画分类');
  const lines = linesOf(data)
    .filter((line) => line.id === 'yunjie')
    .map((line) => {
      const seen = new Set<string>();
      return {
        id: line.id,
        name: plain(line.info.show) || line.id,
        episodes: line.episodes.flatMap((ep) => {
          const episodeId = numericId(ep.nid),
            label = plain(ep.name);
          if (seen.has(episodeId) || !label || text(ep.from) !== line.id) return [];
          seen.add(episodeId);
          return [
            {
              id: episodeId,
              label,
              number: episodeNumber(label),
              kind: /SP|特别|特典/i.test(label) ? ('special' as const) : ('episode' as const),
              locator: { sourceId: 'gugu', animeId: id, lineId: line.id, episodeId },
            },
          ];
        }),
      };
    })
    .filter((line) => line.episodes.length);
  if (!lines.length || new Set(lines.map((line) => line.id)).size !== lines.length)
    throw new AppError('INVALID_RESPONSE', '咕咕没有返回有效选集');
  return { ...card, lines };
}
export function parseGuguMedia(value: unknown): ResolvedMedia {
  const data = object(value);
  let nested = data.json;
  if (typeof nested === 'string') {
    try {
      nested = JSON.parse(nested);
    } catch {
      throw new AppError('INVALID_RESPONSE', '咕咕播放响应格式已变化');
    }
  }
  const result = nested ? object(nested) : data;
  if (/点数|付费|登录|授权|会员/.test(text(result.msg)))
    throw new AppError('ACCESS_REQUIRED', '咕咕此线路需要额外授权，当前仅支持公开播放');
  if (!text(result.url)) throw new AppError('NO_MEDIA', '咕咕暂未提供这一集的媒体，请换源');
  const url = validateUrl(text(result.url)).href;
  return { url, format: mediaFormat(url), headers: { 'User-Agent': 'Mozilla/5.0' } };
}

export class GuguSource implements AnimeSource {
  manifest: SourceManifest = {
    id: 'gugu',
    name: '咕咕动漫',
    version: '1.0.0',
    description: '番剧与剧场版；仅开放公开的咕咕新线，旧 A 线返回点数不足。分页通过读取下一页确认',
    allowedHosts: HOSTS,
    capabilities: ['search', 'home', 'catalog', 'play'],
    catalogFilters: [
      {
        key: 'channel',
        label: '分类',
        defaultValue: '6',
        options: [
          { value: '6', label: '番剧' },
          { value: '21', label: '剧场版' },
        ],
      },
      { key: 'sort', label: '排序', defaultValue: '最新', options: choices(['最新', '最热', '最赞']) },
      {
        key: 'class',
        label: '题材',
        options: choices([
          '',
          '科幻',
          '少女',
          '搞笑',
          '推理',
          '美食',
          '日常',
          '魔法',
          '爱情',
          '治愈',
          '音乐',
          '冒险',
          '歌舞',
          '竞技',
          '乙女向',
          '运动',
          '热血',
          '剧情',
          '奇幻',
          '游戏',
          '校园',
          '战斗',
          '恋爱',
          '励志',
          '后宫',
          '悬疑',
          '泡面番',
          '神魔',
          '百合',
          '青春',
          '职场',
          '战争',
        ]),
      },
    ],
  };
  private async call(path: string, params: Record<string, string>, ctx: SourceContext, play = false) {
    const now = String(Math.floor(Date.now() / 1000));
    return decodeGugu(
      await ctx.http.json(`${BASE}/api.php/getappapi.index/${path}`, {
        method: 'POST',
        body: new URLSearchParams(params).toString(),
        signal: ctx.signal,
        allowedHosts: HOSTS,
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'app-api-verify-time': now,
          'app-ui-mode': 'light',
          ...(play ? { 'app-api-verify-sign': encryptGugu(now) } : {}),
        },
      }),
    );
  }
  async search(input: SearchInput, ctx: SourceContext): Promise<SearchPage> {
    checkedPage(input.page);
    const get = async (page: number) =>
      array(
        (await this.call('searchList', { type_id: '0', keywords: input.keyword, page: String(page) }, ctx))
          .search_list,
      );
    const items = await get(input.page);
    const next = items.length ? await get(input.page + 1) : [];
    return {
      items: guguCards(items),
      page: input.page,
      hasMore: nextPageExists(
        items.map((v) => text(object(v).vod_id)),
        next.map((v) => text(object(v).vod_id)),
      ),
    };
  }
  async getCatalog(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage> {
    checkedFilters(this.manifest, input);
    const { channel = '6', ...filters } = input.filters;
    const get = async (page: number) =>
      guguCards(
        (await this.call('typeFilterVodList', { ...filters, type_id: channel, page: String(page) }, ctx))
          .recommend_list,
        channel,
      );
    const items = await get(input.page);
    const next = items.length ? await get(input.page + 1) : [];
    return {
      items,
      page: input.page,
      hasMore: nextPageExists(
        items.map((v) => v.id),
        next.map((v) => v.id),
      ),
    };
  }
  async getHome(ctx: SourceContext): Promise<HomeSection[]> {
    const data = await this.call('initV119', {}, ctx);
    return array(data.type_list)
      .map(object)
      .filter((type) => [6, 21].includes(Number(type.type_id)))
      .map((type) => ({
        title: plain(type.type_name),
        items: guguCards(type.recommend_list, text(type.type_id)).slice(0, 24),
      }))
      .filter((section) => section.items.length);
  }
  async getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail> {
    return parseGuguDetail(await this.call('vodDetail', { vod_id: numericId(ref.id) }, ctx), ref.id);
  }
  async resolve(episode: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia> {
    const data = await this.call('vodDetail', { vod_id: numericId(episode.animeId) }, ctx);
    const detail = parseGuguDetail(data, episode.animeId);
    if (
      !detail.lines.find((l) => l.id === episode.lineId)?.episodes.some((ep) => ep.id === episode.episodeId)
    )
      throw new AppError('EPISODE_NOT_FOUND', '咕咕选集已变化，请重新打开详情', 404);
    const line = linesOf(data).find((l) => l.id === episode.lineId)!;
    const ep = line.episodes.find((v) => text(v.nid) === episode.episodeId)!;
    return parseGuguMedia(
      await this.call(
        'vodParse',
        { parse_api: text(line.info.parse), url: encryptGugu(text(ep.url)), token: text(ep.token) },
        ctx,
        true,
      ),
    );
  }
}
