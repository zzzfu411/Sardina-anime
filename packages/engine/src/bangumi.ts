import { z } from 'zod';
import { APP_VERSION, type AnimeCard, type BangumiResult, type BangumiSubject } from '../../core/src/types';
import { inferSeason, normalizeTitle } from '../../core/src/matching';
import { HttpClient } from './http';
import { AppError } from './errors';
import { RequestCache } from './request-cache';

const HOST = 'api.bgm.tv';
const BASE = `https://${HOST}/v0`;
const TTL = 6 * 60 * 60_000;
export const bangumiId = z.string().regex(/^[1-9]\d{0,8}$/);
const subjectSchema = z.object({
  id: z.number().int().positive().max(999999999),
  type: z.number().int(),
  name: z.string().max(1000),
  name_cn: z.string().max(1000),
  date: z.string().nullable().optional(),
  platform: z.string().max(100),
  infobox: z.array(z.object({ key: z.string(), value: z.unknown() })).optional(),
  rating: z.object({
    score: z.number().finite().min(0).max(10),
    total: z.number().int().nonnegative(),
    rank: z.number().int().nonnegative(),
  }),
});

export function parseBangumiSubject(value: unknown): BangumiSubject {
  const result = subjectSchema.safeParse(value);
  if (!result.success)
    throw new AppError('BANGUMI_RESPONSE', 'Bangumi 返回的数据结构已变化，请稍后重试。', 502);
  const item = result.data;
  if (item.type !== 2)
    throw new AppError('BANGUMI_NOT_ANIME', '这个 Bangumi 条目不是动画，请选择动画条目。', 400);
  const aliases = (item.infobox ?? [])
    .filter((f) => f.key === '别名' || f.key === '中文名')
    .flatMap((f) =>
      typeof f.value === 'string'
        ? [f.value]
        : Array.isArray(f.value)
          ? f.value.flatMap((a) => (a && typeof a === 'object' && typeof a.v === 'string' ? [a.v] : []))
          : [],
    )
    .filter((s) => s.length <= 1000)
    .slice(0, 50);
  const date = item.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : undefined;
  return {
    id: String(item.id),
    title: item.name_cn || item.name,
    originalTitle: item.name,
    aliases,
    date,
    year: date ? Number(date.slice(0, 4)) : undefined,
    platform: item.platform,
    kind:
      item.platform === 'TV'
        ? 'tv'
        : /剧场|劇場|Movie/i.test(item.platform)
          ? 'movie'
          : /^(OVA|OAD)$/i.test(item.platform)
            ? 'ova'
            : /^(SP|Special)$/i.test(item.platform)
              ? 'special'
              : 'unknown',
    ...(item.rating.total > 0 && item.rating.score > 0 ? { score: item.rating.score } : {}),
    total: item.rating.total,
    ...(item.rating.rank > 0 && item.rating.total > 0 ? { rank: item.rating.rank } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export function exactBangumiMatch(card: AnimeCard, subject: BangumiSubject): boolean {
  if (!card.year || card.year !== subject.year || card.kind === 'unknown' || card.kind !== subject.kind)
    return false;
  const season = inferSeason(subject.title) ?? inferSeason(subject.originalTitle);
  // A broad alias must not silently cross a season boundary.
  if ((card.season ?? inferSeason(card.title)) !== season) return false;
  const names = new Set([subject.title, subject.originalTitle, ...subject.aliases].map(normalizeTitle));
  return [card.title, ...(card.aliases ?? [])].some((name) => names.has(normalizeTitle(name)));
}

/** Public read-only metadata, independent from the playback source's health/cookies. */
export class BangumiClient {
  readonly http: HttpClient;
  private cache = new RequestCache(400);
  private stop = new AbortController();
  constructor(http = new HttpClient()) {
    this.http = http;
  }

  private options(signal: AbortSignal) {
    return {
      signal: AbortSignal.any([signal, this.stop.signal]),
      allowedHosts: [HOST],
      timeout: 8000,
      headers: {
        'User-Agent': `zzzfu411/Sardina-anime/${APP_VERSION} (https://github.com/zzzfu411/Sardina-anime)`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
  }
  clearCache() {
    this.cache.clear();
  }
  close() {
    this.stop.abort();
    this.cache.clear();
    this.http.close();
  }

  async subject(id: string, signal?: AbortSignal): Promise<BangumiSubject> {
    if (!bangumiId.safeParse(id).success) throw new AppError('INVALID_INPUT', 'Bangumi 条目编号无效', 400);
    return this.cache.load(
      'subject:' + id,
      async (shared) => {
        const subject = parseBangumiSubject(
          await this.http.json(BASE + '/subjects/' + id, this.options(shared)),
        );
        if (subject.id !== id) throw new AppError('BANGUMI_RESPONSE', 'Bangumi 返回的条目编号不一致。', 502);
        return subject;
      },
      { signal, ttl: TTL, timeout: 9000 },
    );
  }

  async search(
    keyword: string,
    signal?: AbortSignal,
  ): Promise<{ items: BangumiSubject[]; complete: boolean }> {
    keyword = keyword.trim().slice(0, 200);
    if (!keyword) return { items: [], complete: true };
    return this.cache.load(
      'search:' + keyword,
      async (shared) => {
        const value = await this.http.json(BASE + '/search/subjects?limit=20&offset=0', {
          ...this.options(shared),
          method: 'POST',
          body: JSON.stringify({ keyword, sort: 'match', filter: { type: [2], nsfw: false } }),
        });
        const page = z
          .object({ data: z.array(z.unknown()).max(20), total: z.number().int().nonnegative() })
          .safeParse(value);
        if (!page.success) throw new AppError('BANGUMI_RESPONSE', 'Bangumi 搜索响应无效，请稍后重试。', 502);
        const items = page.data.data.map(parseBangumiSubject);
        return {
          items: [...new Map(items.map((item) => [item.id, item])).values()],
          complete: page.data.total <= items.length,
        };
      },
      { signal, ttl: TTL, timeout: 9000 },
    );
  }

  async match(card: AnimeCard, manualId?: string, signal?: AbortSignal): Promise<BangumiResult> {
    if (manualId)
      return {
        status: 'matched',
        subject: await this.subject(manualId, signal),
        candidates: [],
        match: 'manual',
      };
    const externalId = card.externalIds?.bangumi;
    if (externalId && bangumiId.safeParse(externalId).success) {
      const subject = await this.subject(externalId, signal);
      const conflict =
        (card.year && subject.year && card.year !== subject.year) ||
        (card.kind !== 'unknown' && subject.kind !== 'unknown' && card.kind !== subject.kind) ||
        (card.season !== undefined &&
          inferSeason(subject.title) !== undefined &&
          card.season !== inferSeason(subject.title));
      return conflict
        ? { status: 'ambiguous', candidates: [subject] }
        : { status: 'matched', subject, candidates: [], match: 'external-id' };
    }
    let page = await this.search(card.title, signal);
    if (!page.items.length && card.aliases?.[0]) page = await this.search(card.aliases[0], signal);
    const exact = page.items.filter((subject) => exactBangumiMatch(card, subject));
    if (page.complete && exact.length === 1) {
      const subject = await this.subject(exact[0].id, signal);
      if (exactBangumiMatch(card, subject))
        return { status: 'matched', subject, candidates: [], match: 'exact' };
    }
    return { status: page.items.length ? 'ambiguous' : 'not-found', candidates: page.items };
  }
}
