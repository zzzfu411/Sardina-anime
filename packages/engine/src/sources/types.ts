import type {
  AnimeCard,
  AudienceSnapshot,
  CatalogInput,
  CatalogPage,
  DanmakuFeed,
  EpisodeLocator,
  HomeSection,
  ScheduleDay,
  SearchInput,
  SearchPage,
  SourceDetail,
  SourceManifest,
  SourceRef,
} from '../../../core/src/types';
import type { HttpClient } from '../http';
export interface SourceContext {
  http: HttpClient;
  signal?: AbortSignal;
  refresh?: boolean;
}
export interface ResolvedMedia {
  url: string;
  format: 'hls' | 'mp4' | 'auto';
  headers?: Record<string, string>;
  expiresAt?: number;
  /** Fixed CDN origins declared by the adapter, never provided by the browser. */
  allowedPortOrigins?: string[];
  /** Public hosts this playback URL and its playlist entries may use. Adapters set this; it is not the API host list. */
  allowedHosts?: string[];
}
export interface AnimeSource {
  manifest: SourceManifest;
  search(input: SearchInput, ctx: SourceContext): Promise<SearchPage>;
  getDetail(ref: SourceRef, ctx: SourceContext): Promise<SourceDetail>;
  resolve(episode: EpisodeLocator, ctx: SourceContext): Promise<ResolvedMedia>;
  getDanmaku?(media: ResolvedMedia, ctx: SourceContext): Promise<DanmakuFeed>;
  updateAudience?(
    media: ResolvedMedia,
    action: 'open' | 'close',
    ctx: SourceContext,
  ): Promise<AudienceSnapshot>;
  getHome?(ctx: SourceContext): Promise<HomeSection[]>;
  getCatalog?(input: CatalogInput, ctx: SourceContext): Promise<CatalogPage>;
  getSchedule?(weekday: number, ctx: SourceContext): Promise<ScheduleDay>;
  getSearchCaptcha?(ctx: SourceContext): Promise<{ body: Buffer; contentType: string }>;
  submitSearchCaptcha?(code: string, ctx: SourceContext): Promise<void>;
  clearCache?(): void;
}
export function mediaFormat(url: string): ResolvedMedia['format'] {
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (/\.mp4(?:[?#]|$)/i.test(url)) return 'mp4';
  return 'auto';
}
export function cleanCard(card: AnimeCard): AnimeCard {
  return {
    ...card,
    title: card.title.trim(),
    description: card.description?.replace(/<[^>]*>/g, '').slice(0, 5000),
  };
}
