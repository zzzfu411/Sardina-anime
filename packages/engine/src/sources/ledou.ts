import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
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

const BASE = 'https://js.trgfd.cn';
const HOSTS = ['js.trgfd.cn'];
const PACKAGE = 'com.ledouvideo.app';
const VERSION = '2.8.0';
const MODEL = 'Redmi 25060RK16C';
const KEY = 'qvn1u7FCfu981olp9ploF7VHVS8Dxih7';
const options = (ctx: SourceContext) => ({
  signal: ctx.signal,
  allowedHosts: HOSTS,
  headers: { 'User-Agent': 'okhttp/4.12.0' },
});
const choices = (values: string[]) => values.map((value) => ({ value, label: value || '全部' }));

export function decodeLedou(value: string): Record<string, unknown> {
  try {
    const encoded = value.replace(/^\uFEFF/, '').trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 29) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(KEY), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return object(
      JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8')),
    );
  } catch {
    throw new AppError('INVALID_RESPONSE', '乐豆详情无法解码，接口可能已变化');
  }
}
export function ledouCards(value: unknown, animeCategory = false): AnimeCard[] {
  return uniqueCards(
    array(value)
      .map(object)
      .filter((item) => text(item.typeName) === '动漫' || (animeCategory && !text(item.typeName)))
      .flatMap((item) => {
        const title = plain(item.videoName);
        if (!title || !text(item.videoId)) return [];
        return [
          cleanCard({
            sourceId: 'ledou',
            id: numericId(item.videoId),
            title,
            poster: text(item.fengmiantu || item.dahengtu) || undefined,
            description: plain(item.blurb || item.shortBlurb) || undefined,
            year: year(item.year),
            kind: inferKind(title),
            season: inferSeason(title),
            remarks: plain(item.serialDesc || item.newchapter || item.remarks) || undefined,
            aliases: text(item.bieming) ? [plain(item.bieming)] : undefined,
          }),
        ];
      }),
  );
}
export function parseLedouDetail(value: unknown, id: string): SourceDetail {
  const data = object(value);
  if (text(data.videoId) !== numericId(id)) throw new AppError('INVALID_RESPONSE', '乐豆返回了不匹配的详情');
  const card = ledouCards([data])[0];
  if (!card) throw new AppError('UNSUPPORTED_CATEGORY', '这个条目不属于动漫分类');
  const seen = new Set<string>();
  const episodes = array(data.playUrlList)
    .map(object)
    .flatMap((ep) => {
      const episodeId = numericId(ep.ji),
        label = plain(ep.name);
      if (!label || seen.has(episodeId)) return [];
      seen.add(episodeId);
      return [
        {
          id: episodeId,
          label,
          number: episodeNumber(label),
          kind: /SP|特别|特典|预告|花絮/i.test(label) ? ('special' as const) : ('episode' as const),
          locator: { sourceId: 'ledou', animeId: id, lineId: 'main', episodeId },
        },
      ];
    });
  if (!episodes.length) throw new AppError('NO_EPISODES', '乐豆暂未提供选集');
  return { ...card, lines: [{ id: 'main', name: '乐豆', episodes }] };
}
export function parseLedouMedia(value: unknown): ResolvedMedia {
  const envelope = object(value);
  if (Number(envelope.code) !== 0) throw new AppError('ACCESS_REQUIRED', '乐豆当前未允许播放，请稍后重试');
  const data = object(envelope.data);
  if (data.code !== undefined && Number(data.code) !== 0)
    throw new AppError('ACCESS_REQUIRED', '乐豆此集需要额外访问条件，当前仅支持公开播放');
  const raw = text(data.url);
  if (!raw) throw new AppError('NO_MEDIA', '乐豆暂未提供这一集的媒体，请换源');
  const url = validateUrl(raw).href;
  return { url, format: mediaFormat(url), headers: { 'User-Agent': 'okhttp/4.12.0' } };
}

export class LedouSource implements AnimeSource {
  manifest: SourceManifest = {
    id: 'ledou',
    name: '乐豆动漫',
    version: '1.0.0',
    description: '仓库 yzx 来源；仅动漫，公开目录与临时播放地址，匿名设备会话由本地引擎管理',
    allowedHosts: HOSTS,
    capabilities: ['search', 'home', 'catalog', 'play'],
    catalogFilters: [
      { key: 'area', label: '地区', options: choices(['', '日本', '大陆', '美国', '其他']) },
      {
        key: 'year',
        label: '年份',
        options: choices(['', ...Array.from({ length: 11 }, (_, i) => String(2026 - i)), '更早']),
      },
      { key: 'sort', label: '排序', defaultValue: '最新', options: choices(['最新', '最热', '评分']) },
    ],
  };
  private readonly deviceId = randomBytes(8).toString('hex');
  private device?: { newDeviceCode: string; b: string };
  private async rawDetail(id: string, ctx: SourceContext) {
    numericId(id);
    const query = new URLSearchParams({ version: VERSION, baoming: PACKAGE, channel: 'fenxiang' });
    return decodeLedou(
      await ctx.http.text(
        `${BASE}/cache/videos/${Math.floor(Number(id) / 1000)}/${id}.json?${query}`,
        options(ctx),
      ),
    );
  }
  private async getDevice(ctx: SourceContext) {
    if (this.device) return this.device;
    const response = object(
      await ctx.http.json(`${BASE}/vc/api/device/isnew`, {
        ...options(ctx),
        method: 'POST',
        headers: { ...options(ctx).headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageName: PACKAGE,
          baoming: PACKAGE,
          version: VERSION,
          channel: 'fenxiang',
          uid: 0,
          modelName: MODEL,
          isOld000: 0,
          deviceCode: this.deviceId,
          newDeviceCode: '',
        }),
      }),
    );
    if (Number(response.code) !== 0) throw new AppError('ACCESS_REQUIRED', '乐豆暂未允许建立公开播放会话');
    const data = object(response.data);
    if (!text(data.newDeviceCode) || !text(data.b))
      throw new AppError('INVALID_RESPONSE', '乐豆未返回有效播放会话');
    this.device = { newDeviceCode: text(data.newDeviceCode), b: text(data.b) };
    return this.device;
  }
  private async page(
    path: (page: number) => string,
    page: number,
    ctx: SourceContext,
    animeCategory = false,
  ): Promise<SearchPage> {
    checkedPage(page);
    const current = array(await ctx.http.json(BASE + path(page), options(ctx)));
    const next = current.length ? array(await ctx.http.json(BASE + path(page + 1), options(ctx))) : [];
    return {
      items: ledouCards(current, animeCategory),
      page,
      hasMore: nextPageExists(
        current.map((v) => text(object(v).videoId)),
        next.map((v) => text(object(v).videoId)),
      ),
    };
  }
  async search(input: SearchInput, ctx: SourceContext): Promise<SearchPage> {
    return this.page(
      (page) => `/vc/api/search/${encodeURIComponent(input.keyword)}/${page}.json`,
      input.page,
      ctx,
    );
  }
  async getCatalog(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage> {
    checkedFilters(this.manifest, input);
    const segments = [
      '动漫',
      '全部',
      input.filters.area || '全部',
      input.filters.year || '全部',
      input.filters.sort || '最新',
    ]
      .map(encodeURIComponent)
      .join('/');
    return this.page((page) => `/cache/zhaopian/${segments}/${page}.json`, input.page, ctx, true);
  }
  async getHome(ctx: SourceContext): Promise<HomeSection[]> {
    const page = await this.getCatalog({ page: 1, filters: {} }, ctx);
    return [{ title: '最新动漫', items: page.items.slice(0, 24) }];
  }
  async getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail> {
    return parseLedouDetail(await this.rawDetail(ref.id, ctx), ref.id);
  }
  async resolve(episode: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia> {
    if (episode.lineId !== 'main') throw new AppError('INVALID_LOCATOR', '乐豆播放线路无效', 400);
    const data = await this.rawDetail(episode.animeId, ctx);
    parseLedouDetail(data, episode.animeId);
    // Recompute the current index by stable ji ID; do not persist a signed URL or an old array offset.
    const episodes = array(data.playUrlList).map(object);
    const index = episodes.findIndex((ep) => text(ep.ji) === episode.episodeId);
    if (index < 0) throw new AppError('EPISODE_NOT_FOUND', '乐豆选集已变化，请重新打开详情', 404);
    const device = await this.getDevice(ctx);
    const params = new URLSearchParams({
      sid: episode.animeId,
      ji: numericId(episode.episodeId),
      jiIndex: String(index),
      t: '0',
      y: '0',
      isjiid: '1',
      androidId: this.deviceId,
      modelName: MODEL,
      ...device,
      version: VERSION,
      baoming: PACKAGE,
      channel: 'fenxiang',
    });
    const response = await ctx.http.json(`${BASE}/vc/api/video/playurl?${params}`, {
      ...options(ctx),
      headers: {
        ...options(ctx).headers,
        vuk: createHash('md5')
          .update(episode.animeId + KEY)
          .digest('hex'),
      },
    });
    try {
      return parseLedouMedia(response);
    } catch (error) {
      this.device = undefined;
      throw error;
    }
  }
}
