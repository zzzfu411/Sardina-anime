import type { AnimeCard, Episode, SourceDetail } from '../packages/core/src/types';
import type { AnimeSource } from '../packages/engine/src/sources/types';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { yearFilter } from '../packages/core/src/discovery';

export const card: AnimeCard = {
  sourceId: 'fixture',
  id: 'one',
  title: '星空放映室',
  kind: 'tv',
  year: 2026,
  season: 1,
  poster: 'https://media.example/poster.png',
  description: '用于自动化验收的原创测试画面。',
};
export const episode = (number = 1, lineId = 'mp4', sourceId = 'fixture'): Episode => ({
  id: String(number),
  label: `第 ${number} 话`,
  number,
  kind: 'episode',
  locator: { sourceId, animeId: 'one', lineId, episodeId: String(number) },
});
export const detail: SourceDetail = {
  ...card,
  lines: ['mp4', 'hls'].map((id) => ({
    id,
    name: id === 'mp4' ? 'MP4 测试线路' : 'HLS 测试线路',
    episodes: [episode(1, id), episode(2, id), episode(12.5, id)],
  })),
};
export function fakeSource(id = 'fixture', patch: Partial<AnimeSource> = {}): AnimeSource {
  return {
    manifest: {
      id,
      name: id === 'fixture' ? '测试来源' : id,
      version: '1',
      description: '固定样本',
      allowedHosts: ['media.example'],
      capabilities: ['search', 'home', 'play'],
    },
    search: async (input) => ({
      items: [{ ...card, sourceId: id }],
      page: input.page,
      hasMore: input.page < 2,
    }),
    getHome: async () => [{ title: '测试片库', items: [{ ...card, sourceId: id }] }],
    getDetail: async () => ({ ...detail, sourceId: id }),
    resolve: async (locator) => ({
      url: locator.lineId === 'hls' ? 'https://media.example/index.m3u8' : 'https://media.example/sample.mp4',
      format: locator.lineId === 'hls' ? 'hls' : 'mp4',
      headers: { Referer: 'https://provider.example/' },
    }),
    ...patch,
  };
}
export function discoverySource(): AnimeSource {
  const entries: AnimeCard[] = [
    card,
    { ...card, id: 'movie', title: '星空放映室 剧场版', kind: 'movie', year: 2024 },
    { ...card, id: 'old', title: '海风与旧时光', year: 2020 },
  ];
  return fakeSource('fixture', {
    manifest: {
      ...fakeSource().manifest,
      capabilities: ['search', 'home', 'play', 'catalog', 'schedule'],
      catalogFilters: [
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
        {
          key: 'type',
          label: '类型',
          options: [
            { value: '', label: '全部' },
            { value: 'tv', label: 'TV 动画' },
            { value: 'movie', label: '剧场版' },
          ],
        },
      ],
    },
    getCatalog: async ({ page, filters }) => {
      const filtered = entries.filter(
        (c) =>
          (!filters.year || String(c.year) === filters.year) && (!filters.type || c.kind === filters.type),
      );
      return {
        items: filtered.slice((page - 1) * 2, page * 2),
        page,
        hasMore: page * 2 < filtered.length,
        total: filtered.length,
        pageCount: Math.ceil(filtered.length / 2),
      };
    },
    getSchedule: async (weekday) => ({
      sourceId: 'fixture',
      weekday,
      items: weekday === 2 ? [] : [card],
      checkedAt: new Date().toISOString(),
    }),
    getDetail: async (ref) => {
      const found = entries.find((c) => c.id === ref.id) ?? card;
      return {
        ...detail,
        ...found,
        lines: detail.lines.map((line) => ({
          ...line,
          episodes: line.episodes.map((e) => ({ ...e, locator: { ...e.locator, animeId: found.id } })),
        })),
      };
    },
  });
}
export function response(
  body: string | Buffer,
  headers: Record<string, string> = {},
  status = 200,
): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    statusCode: status,
    headers,
    setTimeout: () => {},
  }) as unknown as IncomingMessage;
}
