import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AnimeCard, EpisodeLocator, Playback } from '../../core/src/types';
import type { ResolvedMedia } from './sources/types';
import { AppError } from './errors';
import { Registry } from './registry';
import { HttpClient, validateUrl } from './http';
import { rewriteHls } from './hls';
import { AudienceLeases } from './audience';
import { RequestCache } from './request-cache';

interface Session {
  id: string;
  locator: EpisodeLocator;
  media: ResolvedMedia;
  touchedAt: number;
  refreshed: boolean;
  /** Permanent fence for the life of this playback, independent of bounded global tombstones. */
  audienceClosed?: boolean;
  resources: Map<string, string>;
  reverse: Map<string, string>;
}
export class MediaGateway {
  private sessions = new Map<string, Session>();
  private images = new Map<string, { url: string; sourceId: string }>();
  private danmaku = new RequestCache(8);
  private audiences = new AudienceLeases();
  private lifetime = new AbortController();
  constructor(private registry: Registry) {}
  presentCard<T extends AnimeCard>(card: T): T {
    if (!card.poster) return card;
    try {
      validateUrl(card.poster);
    } catch {
      return { ...card, imageUrl: undefined };
    }
    const id = createHash('sha256')
      .update(card.sourceId + ':' + card.poster)
      .digest('hex');
    if (this.images.size >= 10000) this.images.delete(this.images.keys().next().value!);
    this.images.set(id, { url: card.poster, sourceId: card.sourceId });
    return { ...card, imageUrl: `/api/v1/images/${id}` };
  }
  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session || Date.now() - session.touchedAt > 2 * 60 * 60_000) {
      void this.delete(id);
      throw new AppError('SESSION_EXPIRED', '播放会话已结束，请重新播放', 410);
    }
    session.touchedAt = Date.now();
    return session;
  }
  private register(session: Session, url: string): string {
    validateUrl(url, session.media.allowedHosts, session.media.allowedPortOrigins);
    if (url.length > 8192) throw new AppError('INVALID_HLS', '媒体地址过长');
    let id = session.reverse.get(url);
    if (!id) {
      if (session.resources.size >= 20000) throw new AppError('RESOURCE_LIMIT', '播放清单资源过多');
      id = randomUUID();
      session.resources.set(id, url);
      session.reverse.set(url, id);
    }
    return `/api/v1/media/${session.id}/${id}`;
  }
  private result(session: Session): Playback {
    const source = this.registry.source(session.locator.sourceId, true);
    return {
      sessionId: session.id,
      url: this.register(session, session.media.url),
      format: session.media.format,
      locator: session.locator,
      refreshed: session.refreshed,
      features: [
        ...(source.getDanmaku && source.manifest.capabilities.includes('danmaku')
          ? ['danmaku' as const]
          : []),
        ...(source.updateAudience && source.manifest.capabilities.includes('audience')
          ? ['audience' as const]
          : []),
      ],
    };
  }
  async create(locator: EpisodeLocator, signal?: AbortSignal): Promise<Playback> {
    const media = await this.registry.resolve(locator, signal);
    validateUrl(media.url, media.allowedHosts, media.allowedPortOrigins);
    await this.detectFormat(locator.sourceId, media, signal);
    for (const [id, session] of this.sessions)
      if (Date.now() - session.touchedAt > 2 * 60 * 60_000) void this.delete(id);
    if (this.sessions.size >= 30) {
      // Old windows may disappear without sending DELETE. Evict the least recently
      // used session, not the first created: it may still be streaming a full episode.
      const oldest = [...this.sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0];
      void this.delete(oldest.id);
    }
    const session: Session = {
      id: randomUUID(),
      locator,
      media,
      touchedAt: Date.now(),
      refreshed: false,
      resources: new Map(),
      reverse: new Map(),
    };
    this.sessions.set(session.id, session);
    return this.result(session);
  }
  async refresh(id: string, signal?: AbortSignal): Promise<Playback> {
    const session = this.session(id);
    if (session.refreshed) throw new AppError('REFRESH_EXHAUSTED', '地址刷新后仍无法播放，请更换线路', 409);
    session.refreshed = true;
    session.media = await this.registry.resolve(session.locator, signal);
    await this.detectFormat(session.locator.sourceId, session.media, signal);
    session.resources.clear();
    session.reverse.clear();
    return this.result(session);
  }
  async delete(id: string) {
    this.sessions.delete(id);
    // Cleanup failures must not prevent switching episodes or deleting a session.
    await this.audiences.close(id).catch(() => {});
  }
  async getDanmaku(id: string, signal?: AbortSignal, refresh = false) {
    const session = this.session(id);
    const source = this.registry.source(session.locator.sourceId);
    if (!source.getDanmaku || !source.manifest.capabilities.includes('danmaku'))
      throw new AppError('DANMAKU_UNSUPPORTED', '这个来源暂未提供弹幕', 422);
    const media = session.media;
    const key = createHash('sha256')
      .update(`${source.manifest.id}:${source.manifest.version}:${media.url}`)
      .digest('hex');
    return this.danmaku.load(
      key,
      (shared) => source.getDanmaku!(media, this.registry.context(source.manifest.id, shared, refresh)),
      {
        signal: AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
        refresh,
        ttl: 5 * 60_000,
        timeout: 20_000,
      },
    );
  }
  async openAudience(id: string) {
    const session = this.session(id);
    if (session.audienceClosed)
      throw new AppError('AUDIENCE_CLOSED', '该播放会话已离开，请使用新的播放会话', 409);
    const source = this.registry.source(session.locator.sourceId);
    if (!source.updateAudience || !source.manifest.capabilities.includes('audience'))
      throw new AppError('AUDIENCE_UNSUPPORTED', '这个来源暂未提供观看人数', 422);
    // Hold the entry URL for the full lease, including a later signed-URL refresh.
    // Each repeat request only touches the local lease, never increments upstream again.
    const media = { ...session.media };
    const update = source.updateAudience.bind(source);
    const context = () => this.registry.context(source.manifest.id, AbortSignal.timeout(8_000));
    try {
      return await this.audiences.open(
        id,
        () => update(media, 'open', context()),
        () => {
          session.audienceClosed = true;
          return update(media, 'close', context());
        },
      );
    } catch (error) {
      session.audienceClosed = true;
      throw error;
    }
  }
  closeAudience(id: string) {
    const session = this.sessions.get(id);
    if (session) session.audienceClosed = true;
    return this.audiences.close(id);
  }
  clearCache() {
    this.danmaku.clear();
  }
  async close() {
    this.lifetime.abort();
    this.clearCache();
    this.sessions.clear();
    await this.audiences.shutdown();
  }
  private async detectFormat(sourceId: string, media: ResolvedMedia, signal?: AbortSignal) {
    if (media.format !== 'auto') return;
    const { response } = await this.registry.context(sourceId).http.stream(media.url, {
      signal,
      timeout: 20_000,
      headers: { ...media.headers, Range: 'bytes=0-511' },
      allowedPortOrigins: media.allowedPortOrigins,
      ...(media.allowedHosts ? { allowedHosts: media.allowedHosts } : {}),
    });
    try {
      if ((response.statusCode ?? 500) >= 400) {
        const error = new AppError('MEDIA_HTTP', `媒体服务器返回 ${response.statusCode}，请尝试换线路`);
        if (response.statusCode !== 416) this.registry.recordFailure(sourceId, 'media', error);
        throw error;
      }
      const type = String(response.headers['content-type'] ?? '');
      const first = await response[Symbol.asyncIterator]().next();
      const bytes = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
      if (
        /mpegurl/i.test(type) ||
        bytes
          .toString('utf8', 0, 100)
          .replace(/^\uFEFF/, '')
          .startsWith('#EXTM3U')
      )
        media.format = 'hls';
      else if (/video\/mp4/i.test(type) || bytes.toString('ascii', 4, 8) === 'ftyp') media.format = 'mp4';
    } finally {
      response.destroy();
    }
  }
  async open(id: string, resourceId: string, range?: string, signal?: AbortSignal) {
    const session = this.session(id);
    const url = session.resources.get(resourceId);
    if (!url) throw new AppError('RESOURCE_NOT_FOUND', '这个播放资源已经失效，请重新播放', 404);
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || !(match[1] || match[2]) || (match[1] && match[2] && Number(match[1]) > Number(match[2])))
        throw new AppError('INVALID_RANGE', '不支持的媒体范围请求', 416);
    }
    const client = this.registry.context(session.locator.sourceId).http;
    const { response, url: finalUrl } = await client.stream(url, {
      signal,
      headers: { ...session.media.headers, ...(range ? { Range: range } : {}) },
      timeout: 25_000,
      allowedPortOrigins: session.media.allowedPortOrigins,
      ...(session.media.allowedHosts ? { allowedHosts: session.media.allowedHosts } : {}),
    });
    const status = response.statusCode ?? 502;
    if (status >= 400) {
      response.destroy();
      const error = new AppError(
        'MEDIA_HTTP',
        `媒体服务器返回 ${status}，可以尝试换线路`,
        status === 416 ? 416 : 502,
      );
      if (status !== 416) this.registry.recordFailure(session.locator.sourceId, 'media', error);
      throw error;
    }
    const type = String(response.headers['content-type'] ?? 'application/octet-stream');
    const iterator = response[Symbol.asyncIterator]();
    const first = await iterator.next();
    const firstBytes = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
    const isHls =
      /mpegurl/i.test(type) ||
      firstBytes
        .toString('utf8', 0, 100)
        .replace(/^\uFEFF/, '')
        .startsWith('#EXTM3U');
    if (isHls) {
      const chunks = [firstBytes];
      let size = firstBytes.length;
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        const data = Buffer.from(next.value);
        size += data.length;
        if (size > 2 * 1024 * 1024) {
          response.destroy();
          throw new AppError('MANIFEST_TOO_LARGE', '播放清单超过大小限制');
        }
        chunks.push(data);
      }
      const body = rewriteHls(Buffer.concat(chunks).toString('utf8'), finalUrl, (uri) =>
        this.register(session, uri),
      );
      return {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' },
        body,
      };
    }
    if (session.media.format === 'hls' && url === session.media.url) {
      response.destroy();
      throw new AppError('INVALID_HLS', '来源未返回有效播放清单，请更换线路');
    }
    const headers: Record<string, string> = {
      'content-type': /^(video\/|audio\/|application\/octet-stream|text\/vtt|application\/vtt)/i.test(type)
        ? type
        : 'application/octet-stream',
      'cache-control': 'private, no-store',
    };
    for (const key of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = response.headers[key];
      if (typeof value === 'string') headers[key] = value;
    }
    const body = Readable.from(
      (async function* () {
        try {
          if (firstBytes.length) yield firstBytes;
          for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
            session.touchedAt = Date.now();
            yield next.value;
          }
        } finally {
          response.destroy();
        }
      })(),
    );
    return { status, headers, body };
  }
  async image(id: string, signal?: AbortSignal) {
    const image = this.images.get(id);
    if (!image) throw new AppError('NOT_FOUND', '封面缓存已过期，请刷新页面', 404);
    const http = this.registry.context(image.sourceId).http ?? new HttpClient();
    const { body, contentType } = await http.bytes(
      image.url,
      {
        signal,
        timeout: 12_000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: image.sourceId === 'aki' ? 'https://www.akianime.com/' : 'https://bgm.tv/',
        },
      },
      8 * 1024 * 1024,
    );
    if (!/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/i.test(contentType))
      throw new AppError('INVALID_IMAGE', '封面格式不支持');
    return { body, contentType };
  }
}
