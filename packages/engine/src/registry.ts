import { randomUUID } from 'node:crypto';
import type {
  CatalogInput,
  CatalogPage,
  EpisodeLocator,
  HomeSection,
  SearchEvent,
  SearchPage,
  SourceDetail,
  SourceRef,
  SourceState,
  ScheduleDay,
  LibraryCheckJob,
  LibraryEntry,
  SourceEpisodeSnapshot,
} from '../../core/src/types';
import { refKey } from '../../core/src/types';
import { episodeSnapshot, withEpisodeSnapshots } from '../../core/src/library';
import { AppError, SearchChallengeError, abortable, publicError } from './errors';
import { HttpClient } from './http';
import { Store } from './store';
import type { AnimeSource, SourceContext } from './sources/types';
import { AniChSource } from './sources/anich';
import { AkiSource } from './sources/aki';
import { GirigiriSource } from './sources/girigiri';
import { ErkuangSource } from './sources/erkuang';
import { GuguSource } from './sources/gugu';
import { LedouSource } from './sources/ledou';
import { XifanSource } from './sources/xifan';
import { sourceValidation } from './release';
import { RequestCache } from './request-cache';
import { SearchChallenges } from './search-challenges';

export class Registry {
  readonly sources: AnimeSource[];
  private clients = new Map<string, HttpClient>();
  private health = new Map<string, SourceState['health']>();
  private cache = new RequestCache();
  private challenges = new SearchChallenges();
  readonly diagnostics: {
    at: string;
    sourceId: string;
    stage: string;
    ms: number;
    ok: boolean;
    code?: string;
    message?: string;
  }[] = [];
  private libraryCheck?: {
    job: LibraryCheckJob;
    promise: Promise<LibraryEntry[]>;
    entries: LibraryEntry[];
    controller: AbortController;
    epoch: number;
  };
  private lifetime = new AbortController();
  constructor(
    readonly store: Store,
    sources: AnimeSource[] = [
      new GirigiriSource(),
      new AniChSource(),
      new AkiSource(),
      new ErkuangSource(),
      new GuguSource(),
      new LedouSource(),
      new XifanSource(),
    ],
  ) {
    this.sources = sources;
    for (const source of sources) this.clients.set(source.manifest.id, new HttpClient());
  }
  states(): SourceState[] {
    return this.sources
      .map((source, i) => ({
        ...source.manifest,
        ...this.store.sourceSettings(source.manifest.id, i),
        health: this.health.get(source.manifest.id) ?? { status: 'unknown' as const },
        verification: sourceValidation[source.manifest.id]?.fullEpisode
          ? ('verified' as const)
          : ('experimental' as const),
      }))
      .sort((a, b) => a.priority - b.priority);
  }
  source(id: string, allowDisabled = false): AnimeSource {
    const source = this.sources.find((s) => s.manifest.id === id);
    if (!source) throw new AppError('SOURCE_NOT_FOUND', '这个来源尚未接入', 404);
    if (!allowDisabled && !this.states().find((s) => s.id === id)?.enabled)
      throw new AppError('SOURCE_DISABLED', '这个来源已停用，请在设置中启用', 409);
    return source;
  }
  context(id: string, signal?: AbortSignal, refresh = false): SourceContext {
    return { http: this.clients.get(id)!, signal, refresh };
  }
  clearCache() {
    this.cache.clear();
    this.challenges.clear();
    for (const source of this.sources) source.clearCache?.();
  }
  close() {
    this.lifetime.abort();
    this.clearCache();
    this.challenges.close();
    for (const client of this.clients.values()) client.close();
  }
  private metadata<T>(
    key: string,
    id: string,
    stage: string,
    read: (ctx: SourceContext) => Promise<T>,
    options: { signal?: AbortSignal; refresh?: boolean; timeout?: number; deduplicate?: boolean },
  ) {
    return this.cache.load(
      key,
      (shared) =>
        this.measured(id, stage, () => abortable(read(this.context(id, shared, options.refresh)), shared)),
      {
        ...options,
        signal: AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]),
      },
    );
  }
  async catalog(
    id: string,
    input: CatalogInput,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<CatalogPage> {
    const source = this.source(id);
    if (!source.getCatalog) throw new AppError('UNSUPPORTED_CATALOG', '这个来源暂不提供分类索引', 400);
    const filters: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.filters)) {
      const filter = source.manifest.catalogFilters?.find((f) => f.key === key);
      if (!filter || !filter.options.some((option) => option.value === value))
        throw new AppError('INVALID_FILTER', '这个来源不支持所选筛选条件', 400);
      if (value) filters[key] = value;
    }
    const key = `catalog:${id}:${input.page}:${input.cursor ?? ''}:${JSON.stringify(Object.entries(filters).sort())}`;
    return this.metadata(
      key,
      id,
      'catalog',
      (ctx) => source.getCatalog!({ page: input.page, cursor: input.cursor, filters }, ctx),
      { signal, refresh },
    );
  }
  async schedule(id: string, weekday: number, signal?: AbortSignal, refresh = false): Promise<ScheduleDay> {
    const source = this.source(id);
    if (!source.getSchedule) throw new AppError('UNSUPPORTED_SCHEDULE', '这个来源暂不提供放送安排', 400);
    const key = `schedule:${id}:${weekday}`;
    return this.metadata(key, id, 'schedule', (ctx) => source.getSchedule!(weekday, ctx), {
      signal,
      refresh,
    });
  }
  async measured<T>(id: string, stage: string, operation: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await operation();
      const ms = Date.now() - start;
      this.health.set(id, { status: 'ok', checkedAt: new Date().toISOString(), latency: ms });
      this.diagnostics.push({ at: new Date().toISOString(), sourceId: id, stage, ms, ok: true });
      return result;
    } catch (error) {
      // Leaving a page cancels its read; it does not mean the source is unhealthy.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof SearchChallengeError) throw error;
      const safe = publicError(error);
      const ms = Date.now() - start;
      this.health.set(id, {
        status: 'error',
        checkedAt: new Date().toISOString(),
        latency: ms,
        message: safe.message,
      });
      this.diagnostics.push({ at: new Date().toISOString(), sourceId: id, stage, ms, ok: false, ...safe });
      throw error;
    } finally {
      this.trimDiagnostics();
    }
  }
  recordFailure(id: string, stage: string, error: unknown): void {
    if (error instanceof Error && error.name === 'AbortError') return;
    const safe = publicError(error);
    this.health.set(id, {
      status: 'error',
      checkedAt: new Date().toISOString(),
      message: safe.message,
    });
    this.diagnostics.push({
      at: new Date().toISOString(),
      sourceId: id,
      stage,
      ms: 0,
      ok: false,
      ...safe,
    });
    this.trimDiagnostics();
  }
  private trimDiagnostics() {
    if (this.diagnostics.length > 300) this.diagnostics.splice(0, this.diagnostics.length - 300);
  }
  async search(
    keyword: string,
    pages: Record<string, number>,
    signal: AbortSignal,
    emit: (event: SearchEvent) => void,
    refresh = false,
    cursors: Record<string, string> = {},
    session: string = randomUUID(),
  ) {
    signal = AbortSignal.any([this.lifetime.signal, signal]);
    const jobs = this.states().filter(
      (s) => s.enabled && (!Object.keys(pages).length || pages[s.id] !== undefined),
    );
    let index = 0;
    const worker = async () => {
      while (index < jobs.length && !signal.aborted) {
        const { id } = jobs[index++];
        const page = pages[id] ?? 1;
        const source = this.source(id);
        const interactive = Boolean(source.getSearchCaptcha && source.submitSearchCaptcha);
        emit({ type: 'source', sourceId: id, status: 'loading' });
        const key = `search:${id}:${this.source(id).manifest.version}:${keyword}:${page}:${cursors[id] ?? ''}`;
        const cached = refresh ? undefined : this.cache.peek<SearchPage>(key);
        try {
          const result =
            cached ??
            (await this.metadata(
              key,
              id,
              'search',
              (ctx) =>
                interactive
                  ? this.challenges.search(
                      source,
                      { keyword, page, cursor: cursors[id] },
                      session,
                      ctx.signal,
                    )
                  : source.search({ keyword, page, cursor: cursors[id] }, ctx),
              { signal, refresh, timeout: 12_000, deduplicate: !interactive },
            ));
          if (!signal.aborted) emit({ type: 'result', sourceId: id, page: result, cached: Boolean(cached) });
        } catch (error) {
          if (!signal.aborted)
            emit(
              error instanceof SearchChallengeError
                ? { type: 'challenge', sourceId: id, challenge: error.challenge }
                : { type: 'error', sourceId: id, ...publicError(error) },
            );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
    if (!signal.aborted) emit({ type: 'done' });
  }
  searchCaptchaImage(id: string) {
    this.source(this.challenges.sourceId(id));
    return this.challenges.image(id);
  }
  refreshSearchChallenge(id: string, signal?: AbortSignal) {
    this.source(this.challenges.sourceId(id));
    return this.challenges.refresh(id, signal);
  }
  submitSearchChallenge(id: string, code: string, signal?: AbortSignal) {
    const sourceId = this.challenges.sourceId(id);
    this.source(sourceId);
    return this.measured(sourceId, 'search-verification', () => this.challenges.submit(id, code, signal));
  }
  cancelSearchChallenge(id: string) {
    this.challenges.cancelChallenge(id);
  }
  cancelSearchSession(id: string) {
    this.challenges.cancel(id);
  }
  async home(id: string, signal?: AbortSignal, refresh = false): Promise<HomeSection[]> {
    const source = this.source(id);
    const key = `home:${id}`;
    if (!source.getHome) return [];
    return this.metadata(key, id, 'home', (ctx) => source.getHome!(ctx), {
      signal,
      refresh,
      timeout: 20_000,
    });
  }
  async detail(ref: SourceRef, signal?: AbortSignal, refresh = false): Promise<SourceDetail> {
    const source = this.source(ref.sourceId);
    const key = `detail:${refKey(ref)}`;
    return this.metadata(key, ref.sourceId, 'detail', (ctx) => source.getDetail(ref, ctx), {
      signal,
      refresh,
    });
  }
  async resolve(locator: EpisodeLocator, signal?: AbortSignal) {
    const combined = AbortSignal.any([
      this.lifetime.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(40_000),
    ]);
    const source = this.source(locator.sourceId);
    return this.measured(locator.sourceId, 'resolve', () =>
      abortable(source.resolve(locator, this.context(locator.sourceId, combined)), combined),
    );
  }
  async lines(locator: EpisodeLocator, signal?: AbortSignal) {
    const source = this.source(locator.sourceId);
    if (!(source instanceof AniChSource)) return [];
    const combined = AbortSignal.any([
      this.lifetime.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    return abortable(source.getLines(locator, this.context(locator.sourceId, combined)), combined);
  }
  libraryCheckStatus(): LibraryCheckJob | null {
    return this.libraryCheck ? structuredClone(this.libraryCheck.job) : null;
  }
  resetLibraryCheck() {
    this.libraryCheck?.controller.abort();
    this.libraryCheck = undefined;
  }
  startLibraryCheck(id?: string): LibraryCheckJob {
    this.lifetime.signal.throwIfAborted();
    if (this.libraryCheck && this.libraryCheck.epoch !== this.store.libraryEpoch) this.resetLibraryCheck();
    const entries = id
      ? [this.store.getLibrary(id)]
      : this.store.library().filter((entry) => entry.status !== 'completed');
    if (this.libraryCheck?.job.running) {
      for (const entry of entries) {
        if (this.libraryCheck.job.items.some((item) => item.id === entry.id)) continue;
        this.libraryCheck.entries.push(entry);
        this.libraryCheck.job.items.push({ id: entry.id, title: entry.card.title, status: 'pending' });
        this.libraryCheck.job.total++;
      }
      return this.libraryCheckStatus()!;
    }
    const job: LibraryCheckJob = {
      id: randomUUID(),
      running: true,
      total: entries.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      startedAt: new Date().toISOString(),
      items: entries.map((entry) => ({ id: entry.id, title: entry.card.title, status: 'pending' })),
    };
    const epoch = this.store.libraryEpoch;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    const promise = Promise.resolve().then(() => this.runLibraryCheck(entries, job, epoch, signal));
    this.libraryCheck = { job, promise, entries, controller, epoch };
    // Navigation keeps jobs running; shutdown or restoring a profile cancels them.
    void promise.catch(() => {});
    return this.libraryCheckStatus()!;
  }
  async checkLibrary(id?: string) {
    this.startLibraryCheck(id);
    return this.libraryCheck!.promise;
  }
  private async runLibraryCheck(
    entries: LibraryEntry[],
    job: LibraryCheckJob,
    epoch: number,
    signal: AbortSignal,
  ) {
    let index = 0;
    const worker = async () => {
      while (index < entries.length) {
        signal.throwIfAborted();
        const itemIndex = index++,
          entry = entries[itemIndex],
          item = job.items[itemIndex];
        item.status = 'checking';
        const snapshots: SourceEpisodeSnapshot[] = [];
        const failures: string[] = [];
        let primary: SourceDetail | undefined;
        for (const ref of entry.refs) {
          signal.throwIfAborted();
          if (!this.states().find((source) => source.id === ref.sourceId)?.enabled) continue;
          try {
            const detail = await this.detail(ref, signal, true);
            if (
              refKey(detail) !== refKey(ref) ||
              detail.lines.some((line) =>
                line.episodes.some(
                  (episode) =>
                    episode.locator.sourceId !== ref.sourceId || episode.locator.animeId !== ref.id,
                ),
              )
            )
              throw new AppError('INVALID_DETAIL', '来源返回的剧集归属不一致，请稍后重试', 502);
            snapshots.push(episodeSnapshot(detail, new Date().toISOString()));
            if (refKey(ref) === refKey(entry.card)) primary = detail;
          } catch (error) {
            signal.throwIfAborted();
            const name = this.states().find((source) => source.id === ref.sourceId)?.name ?? ref.sourceId;
            failures.push(`${name}：${publicError(error).message}`);
          }
        }
        signal.throwIfAborted();
        if (!snapshots.length && !failures.length) failures.push('关联来源已全部停用，暂不能检查更新');
        let current: LibraryEntry | undefined;
        try {
          current = this.store.getLibrary(entry.id);
        } catch {
          /* removed during the check */
        }
        const sameRefs =
          current &&
          JSON.stringify(current.refs.map(refKey).sort()) === JSON.stringify(entry.refs.map(refKey).sort());
        if (
          !current ||
          epoch !== this.store.libraryEpoch ||
          !sameRefs ||
          current.associationRevision !== entry.associationRevision
        ) {
          item.status = 'skipped';
          item.message = '追番或关联来源已变化，本次结果未写入';
          job.skipped++;
        } else {
          const next = snapshots.length ? withEpisodeSnapshots(current, snapshots) : { ...current };
          if (primary) {
            const { lines: _lines, imageUrl: _image, ...card } = primary;
            next.card = card;
          }
          next.updateError = failures.length ? failures.join('；').slice(0, 1000) : undefined;
          this.store.saveLibrary(next);
          item.status = failures.length ? 'failed' : 'success';
          item.message = next.updateError;
          if (failures.length) job.failed++;
          else job.succeeded++;
        }
        job.completed++;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
      signal.throwIfAborted();
      return this.store.library();
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  }
}
