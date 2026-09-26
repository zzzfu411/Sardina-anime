import type {
  AnimeCard,
  CatalogInput,
  CatalogPage,
  Episode,
  EpisodeLocator,
  HomeSection,
  SearchInput,
  SearchPage,
  SourceDetail,
  SourceRef,
} from '../../../core/src/types';
import { yearFilter } from '../../../core/src/discovery';
import { inferKind, inferSeason } from '../../../core/src/matching';
import { AppError } from '../errors';
import { decodeFields, protoInt, protoItems, protoText } from './protobuf';
import { cleanCard, mediaFormat, type AnimeSource, type ResolvedMedia, type SourceContext } from './types';

const BASE = 'https://anich.sends.eu.org';
const manifest = {
  id: 'anich',
  name: 'AniCh',
  version: '1.1.0',
  description: '番剧目录与多线路播放',
  allowedHosts: ['anich.sends.eu.org'],
  capabilities: ['search', 'home', 'play', 'multiLine', 'catalog'] as const,
  catalogPagination: 'cursor' as const,
  catalogFilters: [
    {
      key: 'type',
      label: '类型',
      options: [
        { value: '', label: '全部' },
        { value: 'tv', label: 'TV 动画' },
        { value: 'movie', label: '剧场版' },
        { value: 'ova', label: 'OVA / 特别篇' },
      ],
    },
    {
      key: 'lang',
      label: '语言',
      options: [
        { value: '', label: '全部' },
        { value: 'ja', label: '日语' },
        { value: 'zh', label: '国语' },
        { value: 'en', label: '英语' },
        { value: 'ko', label: '韩语' },
        { value: 'other', label: '其他' },
      ],
    },
    yearFilter(),
  ],
};
const options = (ctx: SourceContext) => ({
  signal: ctx.signal,
  allowedHosts: manifest.allowedHosts,
  headers: { 'User-Agent': 'app.anich Android 1.5.23' },
});
const card = (id: string, title: string, extra: Partial<AnimeCard> = {}): AnimeCard =>
  cleanCard({ sourceId: 'anich', id, title, kind: inferKind(title), season: inferSeason(title), ...extra });

export function decodeAniCards(bytes: Uint8Array): AnimeCard[] {
  return protoItems(bytes)
    .filter((f) => protoInt(f, 1) && protoText(f, 2))
    .map((f) =>
      card(String(protoInt(f, 1)), protoText(f, 2), {
        poster: protoText(f, 7),
        remarks: protoText(f, 8) || protoText(f, 5) || (protoInt(f, 4) ? `全 ${protoInt(f, 4)} 话` : ''),
        year: Number(protoText(f, 5).match(/^((?:19|20)\d{2})(?:\/|年|$)/)?.[1]) || undefined,
      }),
    );
}

export function decodeAniPage(bytes: Uint8Array, page: number): SearchPage {
  const items = decodeAniCards(bytes);
  // Envelope field 3 is the next-page cursor, not an offset or page number.
  const next = protoInt(decodeFields(bytes), 3);
  return { items, page, hasMore: next > 1, nextCursor: next > 1 ? String(next) : undefined };
}
function cursorOf(input: { page: number; cursor?: string }) {
  if (input.page > 1 && !input.cursor)
    throw new AppError('MISSING_CURSOR', '请从第一页依次翻页，或返回原来的索引链接', 400);
  if (input.cursor && !/^\d{1,12}$/.test(input.cursor))
    throw new AppError('INVALID_CURSOR', '分页标记无效', 400);
  return input.cursor ?? '0';
}

export function decodeAniEpisodes(bytes: Uint8Array, animeId: string, lineId = 'auto'): Episode[] {
  const seen = new Set<number>();
  return protoItems(bytes)
    .flatMap((f) => {
      const number = protoInt(f, 2);
      if (!protoInt(f, 1) || !number || seen.has(number)) return [];
      seen.add(number);
      const title = protoText(f, 8);
      return [
        {
          id: String(number),
          label: `第 ${number} 话${title ? ` ${title}` : ''}`,
          number,
          kind: 'episode' as const,
          locator: { sourceId: 'anich', animeId, lineId, episodeId: String(number) },
        },
      ];
    })
    .sort((a, b) => a.number - b.number);
}

interface AniMedia {
  url: string;
  slug: string;
  format: ResolvedMedia['format'];
}
export function decodeAniMedia(bytes: Uint8Array): AniMedia[] {
  return protoItems(bytes).flatMap((f) => {
    const encoded = protoText(f, 1);
    const url = /^https?:\/\//i.test(encoded)
      ? encoded
      : Buffer.from(encoded.slice(0, 3) + encoded.slice(4), 'base64url').toString('utf8');
    if (!/^https?:\/\//i.test(url)) return [];
    return [
      {
        url,
        slug: protoText(f, 5) || 'default',
        format: /hls|m3u8/i.test(protoText(f, 3)) ? ('hls' as const) : mediaFormat(url),
      },
    ];
  });
}

async function media(ctx: SourceContext, id: string, episode: string): Promise<AniMedia[]> {
  const result = await ctx.http.json<unknown>(
    `${BASE}/vod/${encodeURIComponent(id)}/${encodeURIComponent(episode)}`,
    { ...options(ctx), timeout: 30_000 },
  );
  if (!Array.isArray(result) || !result.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
    throw new AppError('INVALID_RESPONSE', 'AniCh 播放数据格式已变化');
  return decodeAniMedia(Uint8Array.from(result));
}

export class AniChSource implements AnimeSource {
  manifest = { ...manifest, capabilities: [...manifest.capabilities] };

  async getCatalog(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage> {
    const params = new URLSearchParams({ skip: cursorOf(input), nsfw: 'false', res: 'true' });
    for (const key of ['type', 'lang', 'year']) if (input.filters[key]) params.set(key, input.filters[key]);
    const { body } = await ctx.http.bytes(`${BASE}/bangumi/list?${params}`, options(ctx));
    return decodeAniPage(body, input.page);
  }

  async search(input: SearchInput, ctx: SourceContext): Promise<SearchPage> {
    const query = new URLSearchParams({ skip: cursorOf(input), nsfw: 'false', res: 'true' });
    if (input.keyword) query.set('keyword', input.keyword);
    const { body } = await ctx.http.bytes(
      `${BASE}/bangumi/${input.keyword ? 'search' : 'list'}?${query}`,
      options(ctx),
    );
    return decodeAniPage(body, input.page);
  }

  async getHome(ctx: SourceContext): Promise<HomeSection[]> {
    const data = await ctx.http.json<{ data?: { title?: string; list?: Record<string, unknown>[] }[] }>(
      `${BASE}/bangumi/recommend?nsfw=false&res=true`,
      options(ctx),
    );
    return (data.data ?? [])
      .map((section) => ({
        title: section.title || '精选番剧',
        items: (section.list ?? [])
          .filter((item) => item.id && item.title)
          .map((item) => {
            const year = String(item.tagline ?? '').match(/(?:19|20)\d{2}/)?.[0];
            return card(String(item.id), String(item.title), {
              poster: String(item.image ?? ''),
              remarks: String(item.tagline ?? ''),
              year: year ? Number(year) : undefined,
            });
          }),
      }))
      .filter((section) => section.items.length);
  }

  async getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail> {
    const ident = encodeURIComponent(ref.id);
    const [data, raw] = await Promise.all([
      ctx.http.json<Record<string, unknown>>(`${BASE}/bangumi/detail/${ident}`, options(ctx)),
      ctx.http.bytes(`${BASE}/bangumi/episodes/${ident}`, options(ctx)),
    ]);
    if (!data.title) throw new AppError('NOT_FOUND', '来源中未找到这部番剧', 404);
    const episodes = decodeAniEpisodes(raw.body, ref.id);
    const year = data.airdate
      ? new Date(typeof data.airdate === 'number' ? data.airdate : String(data.airdate)).getFullYear()
      : undefined;
    return {
      ...card(ref.id, String(data.title), {
        poster: String(data.image ?? ''),
        description: String(data.overview ?? ''),
        year: year && Number.isFinite(year) ? year : undefined,
        remarks: data.episodes_total ? `全 ${data.episodes_total} 话` : `${episodes.length} 话可用`,
        aliases: Array.isArray(data.titles)
          ? data.titles.filter((v): v is string => typeof v === 'string')
          : undefined,
      }),
      // Only the episode endpoint establishes availability. Never invent episode 1 or guessed episodes.
      lines: [{ id: 'auto', name: '自动选择', episodes }],
    };
  }

  async resolve(locator: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia> {
    const candidates = await media(ctx, locator.animeId, locator.episodeId);
    const selected =
      locator.lineId === 'auto'
        ? (candidates.find((c) => c.format === 'hls' || c.format === 'mp4') ?? candidates[0])
        : candidates.find((c) => c.slug === locator.lineId);
    if (!selected) throw new AppError('NO_MEDIA', '这一集暂时没有可用播放线路');
    return { url: selected.url, format: selected.format, headers: { 'User-Agent': 'Mozilla/5.0' } };
  }

  async getLines(locator: EpisodeLocator, ctx: SourceContext): Promise<{ id: string; name: string }[]> {
    return [...new Set((await media(ctx, locator.animeId, locator.episodeId)).map((c) => c.slug))].map(
      (id) => ({ id, name: id }),
    );
  }
}
