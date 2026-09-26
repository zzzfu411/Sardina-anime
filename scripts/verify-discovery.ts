import { AkiSource } from '../packages/engine/src/sources/aki';
import { AniChSource } from '../packages/engine/src/sources/anich';
import { HttpClient } from '../packages/engine/src/http';
import { readFile, writeFile } from 'node:fs/promises';
import type { CatalogPage, ScheduleDay } from '../packages/core/src/types';

const path = 'docs/validation/discovery-live.json';
let runs: unknown[] = [];
try {
  const previous = JSON.parse(await readFile(path, 'utf8'));
  runs = previous.runs ?? [previous];
} catch {}
const records: unknown[] = [];
const akiHttp = new HttpClient();
const anichHttp = new HttpClient();
const aki = new AkiSource();
const anich = new AniChSource();
let catalogFirst: CatalogPage | undefined;
let searchFirst: CatalogPage | undefined;
const tasks: [string, () => Promise<CatalogPage | ScheduleDay>][] = [
  [
    'aki-catalog',
    () =>
      aki.getCatalog(
        { page: 1, filters: { year: '2024', genre: '恋爱', sort: 'score' } },
        { http: akiHttp, signal: AbortSignal.timeout(25000) },
      ),
  ],
  ['aki-schedule', () => aki.getSchedule(3, { http: akiHttp, signal: AbortSignal.timeout(25000) })],
  [
    'anich-catalog-first',
    async () =>
      (catalogFirst = await anich.getCatalog(
        { page: 1, filters: { year: '2024', type: 'tv', lang: 'ja' } },
        { http: anichHttp, signal: AbortSignal.timeout(25000) },
      )),
  ],
  [
    'anich-catalog-next',
    async () => {
      if (!catalogFirst?.nextCursor) throw new Error('First-page continuation unavailable');
      const next = await anich.getCatalog(
        { page: 2, cursor: catalogFirst.nextCursor, filters: { year: '2024', type: 'tv', lang: 'ja' } },
        { http: anichHttp, signal: AbortSignal.timeout(25000) },
      );
      if (
        !next.items.length ||
        next.items.some((c) => catalogFirst!.items.some((first) => first.id === c.id))
      )
        throw new Error('Next catalog page is empty or overlaps the first page');
      return next;
    },
  ],
  [
    'anich-search-first',
    async () =>
      (searchFirst = await anich.search(
        { page: 1, keyword: '异世界' },
        { http: anichHttp, signal: AbortSignal.timeout(25000) },
      )),
  ],
  [
    'anich-search-next',
    async () => {
      if (!searchFirst?.nextCursor) throw new Error('First search continuation unavailable');
      const next = await anich.search(
        { page: 2, cursor: searchFirst.nextCursor, keyword: '异世界' },
        { http: anichHttp, signal: AbortSignal.timeout(25000) },
      );
      if (!next.items.length || next.items.some((c) => searchFirst!.items.some((first) => first.id === c.id)))
        throw new Error('Next search page is empty or overlaps the first page');
      return next;
    },
  ],
];
for (const [stage, run] of tasks) {
  const start = Date.now();
  try {
    const data = await run();
    const record = {
      stage,
      ok: true,
      ms: Date.now() - start,
      count: data.items.length,
      ...('page' in data
        ? { page: data.page, hasMore: data.hasMore, nextCursor: data.nextCursor, total: data.total }
        : { weekday: data.weekday }),
      examples: data.items.slice(0, 2).map((c) => ({ id: c.id, title: c.title, year: c.year })),
    };
    records.push(record);
    console.log(record);
  } catch (error) {
    const record = {
      stage,
      ok: false,
      ms: Date.now() - start,
      message: error instanceof Error ? error.message : 'check failed',
    };
    records.push(record);
    console.log(record);
  }
}
runs.push({ checkedAt: new Date().toISOString(), records });
await writeFile(path, JSON.stringify({ runs }, null, 2) + '\n');
