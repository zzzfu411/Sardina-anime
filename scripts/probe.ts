import { mkdir, writeFile } from 'node:fs/promises';
import { HttpClient } from '../packages/engine/src/http';
import { AniChSource } from '../packages/engine/src/sources/anich';
import { AkiSource } from '../packages/engine/src/sources/aki';
import { GirigiriSource } from '../packages/engine/src/sources/girigiri';
import { ErkuangSource } from '../packages/engine/src/sources/erkuang';
import { GuguSource } from '../packages/engine/src/sources/gugu';
import { LedouSource } from '../packages/engine/src/sources/ledou';
import { XifanSource } from '../packages/engine/src/sources/xifan';
import { publicError } from '../packages/engine/src/errors';
import type { AnimeSource } from '../packages/engine/src/sources/types';

const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  mode: 'catalog-and-media-probe',
  note: 'HTTP checks are not full playback verification',
  sources: [],
};
const count = Math.max(1, Math.min(10, Number(process.env.PROBE_COUNT ?? 2)));
const selected = process.env.PROBE_SOURCE?.split(',');
const sources: AnimeSource[] = [
  new AniChSource(),
  new AkiSource(),
  new GirigiriSource(),
  new ErkuangSource(),
  new GuguSource(),
  new LedouSource(),
  new XifanSource(),
];
if (selected?.some((id) => !sources.some((source) => source.manifest.id === id)))
  throw new Error('Unknown PROBE_SOURCE');
for (const source of sources.filter((source) => !selected || selected.includes(source.manifest.id))) {
  const ctx = { http: new HttpClient(), signal: AbortSignal.timeout(240_000) };
  const result: Record<string, unknown> = { sourceId: source.manifest.id, stages: [], samples: [] };
  const stage = (name: string, value: unknown) => {
    (result.stages as unknown[]).push({ name, value });
    console.log(source.manifest.id, name, JSON.stringify(value));
  };
  try {
    const home = await source.getHome!(ctx);
    stage('home', { sections: home.length, items: home.flatMap((s) => s.items).length });
    let search = { items: [] as (typeof home)[number]['items'], page: 1, hasMore: false };
    try {
      search = await source.search({ keyword: '葬送', page: 1 }, ctx);
      stage('search', { items: search.items.length });
    } catch (error) {
      stage('search-error', publicError(error));
    }
    const candidates = [
      ...home.flatMap((s) => s.items).slice(0, 3),
      ...search.items,
      ...home.flatMap((s) => s.items),
    ]
      .filter((v, i, a) => a.findIndex((c) => c.id === v.id) === i)
      .slice(0, Math.max(3, count));
    let attempted = 0;
    for (const candidate of candidates) {
      if (attempted >= count) break;
      try {
        const detail = await source.getDetail(candidate, ctx);
        stage('detail', {
          id: candidate.id,
          title: detail.title,
          lines: detail.lines.map((l) => ({ id: l.id, name: l.name, episodes: l.episodes.length })),
        });
        for (const line of detail.lines) {
          const ep = line.episodes[0];
          if (!ep || attempted >= count) continue;
          attempted++;
          try {
            const media = await source.resolve(ep.locator, ctx);
            stage('resolved', {
              locator: ep.locator,
              format: media.format,
              host: new URL(media.url).hostname,
            });
            const { response } = await ctx.http.stream(media.url, {
              headers: { ...media.headers, Range: 'bytes=0-4095' },
              allowedPortOrigins: media.allowedPortOrigins,
              signal: AbortSignal.timeout(30_000),
            });
            const chunk = await response[Symbol.asyncIterator]().next();
            const status = response.statusCode;
            const contentType = response.headers['content-type'];
            response.destroy();
            const sample = {
              animeId: detail.id,
              title: detail.title,
              locator: ep.locator,
              mediaType: media.format,
              status,
              contentType,
              hls: !chunk.done && Buffer.from(chunk.value).toString('utf8', 0, 100).includes('#EXTM3U'),
              ok: (status ?? 500) < 400,
            };
            (result.samples as unknown[]).push(sample);
            stage('media', sample);
          } catch (error) {
            const sample = { locator: ep.locator, ok: false, ...publicError(error) };
            (result.samples as unknown[]).push(sample);
            stage('media', sample);
          }
        }
      } catch (error) {
        stage('detail-error', { id: candidate.id, ...publicError(error) });
      }
    }
  } catch (error) {
    stage('error', publicError(error));
  }
  (report.sources as unknown[]).push(result);
}
await mkdir('docs/validation', { recursive: true });
await writeFile(
  process.env.PROBE_OUTPUT ?? 'docs/validation/source-probe.json',
  JSON.stringify(report, null, 2) + '\n',
);
