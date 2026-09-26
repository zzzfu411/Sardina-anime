import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DetailRatings } from './ratings';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Check,
  ChevronLeft,
  Download,
  Film,
  Link2,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { matchingEpisode, sameAnime } from '../../../packages/core/src/matching';
import { kindLabels, refineSearch } from '../../../packages/core/src/discovery';
import {
  APP_VERSION,
  BACKUP_MAX_BYTES,
  refKey,
  episodeKey,
  statusLabels,
  type AnimeCard,
  type AppSettings,
  type Episode,
  type HistoryEntry,
  type HomeSection,
  type LibraryEntry,
  type SearchPage as SearchPageData,
  type SearchChallenge,
  type SearchContinuation,
  type SourceDetail,
  type SourceState,
  type WatchStatus,
} from '../../../packages/core/src/types';
import {
  api,
  detailPath,
  continuePath,
  patch,
  post,
  preferSettings,
  putSettings,
  searchEvents,
  timeLabel,
  watchPath,
} from './api';
import { AnimeTile, Cover, Empty, ErrorState, Loading, useToast } from './ui';
import { DiscoveryEntrances, SchedulePanel, SearchLanding, ViewToggle, resultClass } from './discovery';
import { AppearanceChoices } from './appearance';
import { SearchCaptcha } from './search-captcha';
import { SearchSourcePicker, useSearchSource } from './search-source';
import { useHistoryMutations, useAnimeHistory, useHistoryContext } from './history';
import {
  recentSeries,
  continuation,
  continuationLabel,
  completedEpisode,
  progressForEpisode,
} from '../../../packages/core/src/progress';
import { SourceRecovery } from './source-recovery';
import { AssociationDialog, useLibraryActions } from './library-actions';
import { useSourcePreference, selectModuleSource } from './module-source';
import { useSearchMemory } from './search-memory';
import { EpisodeBrowser } from './episode-browser';
import { BackupManager } from './backup-manager';
import { pendingUpdateCount } from '../../../packages/core/src/library';

export interface SwitchContext {
  card: AnimeCard;
  episode: Episode;
  position: number;
}
const useSources = () => useQuery({ queryKey: ['sources'], queryFn: () => api<SourceState[]>('/sources') });
const useLibrary = () => useQuery({ queryKey: ['library'], queryFn: () => api<LibraryEntry[]>('/library') });
const useHistory = () =>
  useQuery({ queryKey: ['history-recent'], queryFn: () => api<HistoryEntry[]>('/history/recent') });
const errorText = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试');

export function HomePage() {
  const sources = useSources();
  const history = useHistory();
  const library = useLibrary();
  const [params, setParams] = useSearchParams();
  const [preferredSource, rememberSource, homeSourceReady] = useSourcePreference('home');
  const enabled = sources.data?.filter((s) => s.enabled && s.capabilities.includes('home')) ?? [];
  const source = selectModuleSource(enabled, params.get('source'), preferredSource);
  useEffect(() => {
    if (source && (homeSourceReady || params.has('source'))) rememberSource(source.id);
  }, [source?.id, rememberSource, homeSourceReady, params]);
  const home = useQuery({
    queryKey: ['home', source?.id],
    enabled: Boolean(source) && (homeSourceReady || params.has('source')),
    queryFn: ({ signal }) => api<HomeSection[]>(`/home?sourceId=${source!.id}`, { signal }),
    staleTime: 300_000,
    retry: false,
  });
  const sections = source ? (home.data ?? []).map((section) => ({ ...section, source })) : [];
  const recent = recentSeries(history.data ?? [], library.data ?? []);
  const featured = recent[0]?.card ?? sections.flatMap((s) => s.items)[0];
  const suggestions = [
    ...new Map(sections.flatMap((section) => section.items).map((card) => [refKey(card), card])).values(),
  ]
    .filter((card) => !featured || refKey(card) !== refKey(featured))
    .slice(0, 3);
  const updated = library.data?.filter((e) => pendingUpdateCount(e) > 0) ?? [];
  if (sources.isError)
    return (
      <ErrorState
        error={sources.error}
        retry={() => {
          void sources.refetch();
        }}
      />
    );
  return (
    <div className="editorial-home">
      <div className="page-heading home-heading">
        <div>
          <h1>{recent.length ? '接着上次的故事' : '发现'}</h1>
          <p>{recent.length ? '继续观看，或选一部新的番剧。' : '从一张封面，走进下一个故事。'}</p>
        </div>
        {enabled.length > 0 && (
          <label className="home-source-picker">
            推荐来源
            <select
              aria-label="推荐来源"
              value={source?.id ?? ''}
              onChange={(event) => {
                rememberSource(event.target.value);
                setParams({ source: event.target.value });
              }}
            >
              {enabled.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {featured ? (
        <div className={`home-spread ${suggestions.length ? '' : 'single-story'}`}>
          <section className="cover-story" aria-label={recent.length ? '继续观看' : '封面推荐'}>
            <Link
              className="story-art"
              to={detailPath(featured.sourceId, featured.id)}
              aria-label={`查看封面番剧 ${featured.title}`}
            >
              <Cover card={featured} priority />
            </Link>
            <div className="story-copy">
              <span className="story-kicker">{recent.length ? '继续上次的故事' : '封面推荐'}</span>
              <h2>{featured.title}</h2>
              <div className="story-meta">
                <span>{enabled.find((s) => s.id === featured.sourceId)?.name ?? featured.sourceId}</span>
                {featured.year && <span>{featured.year} 年</span>}
                {featured.kind !== 'unknown' && <span>{kindLabels[featured.kind]}</span>}
              </div>
              <p className="story-description">
                {recent[0]
                  ? completedEpisode(recent[0])
                    ? `${recent[0].episode.label} 已看完`
                    : `${recent[0].episode.label}，已看到 ${timeLabel(recent[0].position)}`
                  : featured.description || featured.remarks || '进入详情，选择线路与剧集。'}
              </p>
              <Link
                className="button primary"
                to={
                  recent[0]
                    ? continuePath(featured.sourceId, featured.id)
                    : detailPath(featured.sourceId, featured.id)
                }
              >
                <Play size={17} fill="currentColor" />
                {recent[0] ? '继续观看' : '查看番剧'}
              </Link>
              <span className="story-footnote">
                {recent[0] ? '接着上次的进度播放' : '线路与剧集见番剧详情'}
              </span>
            </div>
          </section>
          {suggestions.length > 0 && (
            <aside className="selection-rail" aria-label="同源选片">
              <div className="selection-heading">
                <h2>同源选片</h2>
                <span>{source?.name}</span>
              </div>
              <div className="selection-list">
                {suggestions.map((card) => (
                  <Link className="selection-item" key={refKey(card)} to={detailPath(card.sourceId, card.id)}>
                    <Cover card={card} />
                    <div>
                      <h3>{card.title}</h3>
                      <p>{card.remarks || (card.kind !== 'unknown' ? kindLabels[card.kind] : '查看详情')}</p>
                    </div>
                  </Link>
                ))}
              </div>
              <Link className="text-link selection-more" to={'/catalog?source=' + source?.id}>
                浏览全部番剧 <ArrowRight size={14} />
              </Link>
            </aside>
          )}
        </div>
      ) : (source && home.isPending) || sources.isPending ? (
        <div className="story-loading">
          <Loading label="正在找今天的番剧…" />
        </div>
      ) : (
        <Empty
          title={enabled.length ? '暂时没有推荐内容' : '先启用一个番剧来源'}
          action={
            <Link className="button secondary" to="/settings">
              管理来源
            </Link>
          }
        >
          你也可以直接搜索片名，或在来源恢复后刷新。
        </Empty>
      )}
      <DiscoveryEntrances />
      {updated.length > 0 && (
        <div className="update-strip">
          <span className="status-dot" />
          <span>{updated.length} 部追番有新的剧集条目</span>
          <Link to="/library">
            去看看 <ArrowRight size={14} />
          </Link>
        </div>
      )}
      {recent.length > 0 && (
        <section className="section">
          <div className="section-heading">
            <h2>接着看</h2>
            <Link className="text-link" to="/history">
              全部记录 <ArrowRight size={15} />
            </Link>
          </div>
          <div className="continue-grid">
            {recent.map((entry) => (
              <Link
                key={entry.key}
                to={continuePath(entry.card.sourceId, entry.card.id)}
                className="continue-card"
              >
                <Cover card={entry.card} />
                <div>
                  <strong>{entry.card.title}</strong>
                  <span>{entry.episode.label}</span>
                  <div className="progress">
                    <i
                      style={{
                        width: `${entry.duration > 0 ? Math.min(100, (entry.position / entry.duration) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <small>
                    {completedEpisode(entry)
                      ? '本集已看完 · 查看下一话'
                      : `已看到 ${timeLabel(entry.position)}`}
                  </small>
                </div>
                <Play size={20} />
              </Link>
            ))}
          </div>
        </section>
      )}
      <SchedulePanel compact />
      {sections.slice(0, 2).map((section, index) => (
        <section className="section" key={`${section.source.id}:${index}`}>
          <div className="section-heading">
            <h2>{section.title}</h2>
            <Link
              className="text-link"
              to={
                '/catalog?' +
                new URLSearchParams({ source: section.source.id, ...(section.catalogFilters ?? {}) })
              }
            >
              {section.source.name} · 查看更多 <ArrowRight size={14} />
            </Link>
          </div>
          {section.description && <p className="section-note">{section.description}</p>}
          <div className="poster-grid">
            {section.items.slice(0, 12).map((card) => (
              <AnimeTile key={refKey(card)} card={card} sourceName={section.source.name} />
            ))}
          </div>
        </section>
      ))}
      {source && home.isError && (
        <div className="source-notice">
          <span>{source.name} 暂时没有响应，可以切换推荐来源</span>
          <button
            className="text-link"
            onClick={() => {
              void home.refetch();
            }}
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
}

interface SourceSearch {
  status: 'loading' | 'done' | 'error' | 'challenge' | 'cancelled';
  challenge?: SearchChallenge;
  focusChallenge?: boolean;
  page?: SearchPageData;
  message?: string;
  requestedPage?: number;
  requestedCursor?: string;
}
function continuedSearch(
  old: SourceSearch | undefined,
  event: SearchContinuation,
  focus = false,
): SourceSearch {
  if (event.type === 'challenge')
    return { ...old, status: 'challenge', challenge: event.challenge, focusChallenge: focus };
  const items =
    event.page.page > 1
      ? [...(old?.page?.items ?? []), ...event.page.items].filter(
          (c, i, all) => all.findIndex((x) => refKey(x) === refKey(c)) === i,
        )
      : event.page.items;
  return { status: 'done', page: { ...event.page, items } };
}
export function SearchPage() {
  const [params] = useSearchParams();
  const selection = useSearchSource();
  const keyword = params.get('q')?.trim() ?? '';
  if (selection.pending) return <Loading label="正在读取搜索来源…" />;
  if (selection.error) return <ErrorState error={selection.error} retry={selection.retry} />;
  if (!keyword) return <SearchLanding />;
  if (!selection.source)
    return (
      <>
        <div className="page-heading">
          <h1>“{keyword}”</h1>
        </div>
        <SearchSourcePicker />
        <Empty title="请选择可用的搜索来源">原来源可能已停用，选择其他来源后继续搜索。</Empty>
      </>
    );
  // Source and keyword own separate retained results; verification sessions are still released on leave.
  return (
    <SourceSearchPage
      key={JSON.stringify([selection.source.id, keyword])}
      selectedSource={selection.source}
    />
  );
}
function SourceSearchPage({ selectedSource }: { selectedSource: SourceState }) {
  const [params, setParams] = useSearchParams();
  const keyword = params.get('q')?.trim() ?? '';
  const linkTo = params.get('linkTo');
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const client = useQueryClient();
  const sources = useSources();
  const library = useLibrary();
  const { results, setResults, restored, clearMemory } = useSearchMemory<SourceSearch>(
    selectedSource.id,
    keyword,
    location.search,
  );
  const [running, setRunning] = useState(!restored);
  const [error, setError] = useState('');
  const changeFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next);
  };
  const abort = useRef<AbortController>(undefined);
  const searchSession = useRef('');
  const run = useCallback(
    (pages: Record<string, number> = {}, refresh = false, cursors: Record<string, string> = {}) => {
      if (!keyword) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      if (!Object.keys(pages).length) {
        clearMemory();
        setResults({});
      }
      setRunning(true);
      setError('');
      void searchEvents(
        keyword,
        selectedSource.id,
        pages,
        controller.signal,
        (event) => {
          if (event.type === 'done') {
            setRunning(false);
            return;
          }
          if (controller.signal.aborted || event.sourceId !== selectedSource.id) return;
          setResults((previous) => {
            const old = previous[event.sourceId];
            if (event.type === 'source')
              return {
                ...previous,
                [event.sourceId]: {
                  ...old,
                  status: 'loading',
                  challenge: undefined,
                  requestedPage: pages[event.sourceId] ?? 1,
                  requestedCursor: cursors[event.sourceId],
                },
              };
            if (event.type === 'error')
              return { ...previous, [event.sourceId]: { ...old, status: 'error', message: event.message } };
            return { ...previous, [event.sourceId]: continuedSearch(old, event) };
          });
        },
        refresh,
        cursors,
        searchSession.current,
      )
        .catch((e) => {
          if (!controller.signal.aborted) setError(errorText(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setRunning(false);
        });
    },
    [keyword, selectedSource.id],
  );
  useEffect(() => {
    const session = crypto.randomUUID();
    searchSession.current = session;
    if (!restored) run();
    const release = () => {
      abort.current?.abort();
      void api(`/search/sessions/${session}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [run]);
  const waiting = Object.entries(results).filter(
    ([, result]) => result.status === 'challenge' && result.challenge,
  );
  const currentStatus = results[selectedSource.id]?.status;
  const restartSource = (id: string, result: SourceSearch) =>
    run(
      { [id]: result.requestedPage ?? 1 },
      true,
      result.requestedCursor ? { [id]: result.requestedCursor } : {},
    );
  const items = Object.entries(results)
    .filter(([id]) => id === selectedSource.id)
    .flatMap(([, result]) => result.page?.items ?? []);
  const refined = refineSearch(
    items,
    params.get('kind') ?? '',
    params.get('year') ?? '',
    params.get('sort') ?? '',
  );
  const cards = [...new Map(refined.map((card) => [refKey(card), card])).values()];
  const years = [...new Set(items.flatMap((card) => (card.year ? [card.year] : [])))].sort((a, b) => b - a);
  const linkEntry = library.data?.find((e) => e.id === linkTo);
  const stateBase = (location.state as { linkBase?: AnimeCard } | null)?.linkBase;
  const baseSource = params.get('linkSource');
  const baseId = params.get('linkItem');
  const linking = Boolean(linkTo || stateBase || (baseSource && baseId));
  const baseDetail = useQuery({
    queryKey: ['link-base', baseSource, baseId],
    enabled: Boolean(!linkEntry && !stateBase && baseSource && baseId),
    queryFn: ({ signal }) =>
      api<SourceDetail>(`/sources/${baseSource}/detail?itemId=${encodeURIComponent(baseId!)}`, { signal }),
  });
  const linkBase = linkEntry?.card ?? stateBase ?? baseDetail.data;
  const [associationTarget, setAssociationTarget] = useState<AnimeCard>();
  const switchContext = (location.state as { switchContext?: SwitchContext } | null)?.switchContext;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>“{keyword}”</h1>
          <p>
            {selectedSource.name} · {cards.length} 个结果
            {running && ' · 搜索中…'}
          </p>
        </div>
        <button className="button secondary small" onClick={() => run({}, true)} disabled={running}>
          <RefreshCw size={16} />
          重新搜索
        </button>
      </div>
      <SearchSourcePicker
        status={
          error || currentStatus === 'error'
            ? '搜索失败，可重试或切换来源'
            : currentStatus === 'cancelled'
              ? '已取消验证，可重试或切换来源'
              : waiting.length
                ? '当前来源需要验证码'
                : running
                  ? `正在搜索 ${selectedSource.name}…`
                  : `${selectedSource.name} · 已返回 ${items.length} 条结果`
        }
      />
      {linking && (
        <div className="info-banner">
          <Link2 size={18} />
          <span>为「{linkBase?.title ?? '当前番剧'}」关联其他来源。请确认季度与版本一致。</span>
        </div>
      )}
      {switchContext && (
        <div className="info-banner">
          原来源：
          {sources.data?.find((source) => source.id === switchContext.card.sourceId)?.name ??
            switchContext.card.sourceId}{' '}
          · {switchContext.episode.label} · {timeLabel(switchContext.position)}
          。请选择同一季度和版本，能够唯一对应剧集时会接续此位置。
        </div>
      )}
      {linking && baseDetail.isError && (
        <ErrorState error={baseDetail.error} retry={() => void baseDetail.refetch()} />
      )}
      {associationTarget && linkBase && (
        <AssociationDialog
          card={linkBase}
          target={associationTarget}
          libraryId={linkEntry?.id}
          onClose={() => setAssociationTarget(undefined)}
          onLinked={(entry) => {
            setAssociationTarget(undefined);
            toast('已确认并关联来源');
            navigate(detailPath(entry.card.sourceId, entry.card.id));
          }}
        />
      )}

      {waiting.map(([id, result]) => (
        <SearchCaptcha
          key={result.challenge!.id}
          challenge={result.challenge!}
          focus={result.focusChallenge}
          name={sources.data?.find((s) => s.id === id)?.name ?? id}
          hasSourceResults={Boolean(result.page?.items.length)}
          onContinue={(event) =>
            setResults((previous) =>
              previous[id]?.challenge?.id === result.challenge!.id
                ? { ...previous, [id]: continuedSearch(previous[id], event, true) }
                : previous,
            )
          }
          onCancel={() =>
            setResults((previous) =>
              previous[id]?.challenge?.id === result.challenge!.id
                ? {
                    ...previous,
                    [id]: {
                      ...previous[id],
                      status: 'cancelled',
                      challenge: undefined,
                      message: '已取消验证码输入，可重新搜索此来源。',
                    },
                  }
                : previous,
            )
          }
          onRestart={() => restartSource(id, result)}
        />
      ))}
      <div className="search-refinements">
        <div className="results-tools">
          <select
            aria-label="搜索结果类型"
            value={params.get('kind') ?? ''}
            onChange={(e) => changeFilter('kind', e.target.value)}
          >
            <option value="">全部类型</option>
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="搜索结果年份"
            value={params.get('year') ?? ''}
            onChange={(e) => changeFilter('year', e.target.value)}
          >
            <option value="">全部年份</option>
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
            <option value="unknown">年份未标注</option>
          </select>
          <select
            aria-label="搜索结果排序"
            value={params.get('sort') ?? ''}
            onChange={(e) => changeFilter('sort', e.target.value)}
          >
            <option value="">默认顺序</option>
            <option value="year">年份从新到旧</option>
            <option value="title">按片名排列</option>
          </select>
        </div>
        <ViewToggle value={params.get('view')} onChange={(value) => changeFilter('view', value)} />
      </div>
      <p className="filter-scope">
        筛选作用于已返回的结果。按题材浏览完整来源片库，请前往{' '}
        <Link to={'/catalog?source=' + selectedSource.id}>番剧索引</Link>。
      </p>
      {error && <ErrorState error={new Error(error)} retry={() => run()} />}
      <div className={resultClass(params.get('view')) + ' search-grid'}>
        {cards.map((card) => (
          <AnimeTile
            key={refKey(card)}
            card={card}
            sourceName={selectedSource.name}
            routeState={location.state}
            showDescription={params.get('view') === 'list'}
            action={
              linking ? (
                <button
                  className="button secondary small wide"
                  disabled={!linkBase || library.isPending}
                  onClick={() => {
                    setAssociationTarget(card);
                  }}
                >
                  <Link2 size={14} />
                  关联此来源
                </button>
              ) : undefined
            }
          />
        ))}
      </div>
      {running && <Loading label={`正在搜索 ${selectedSource.name}…`} />}
      {!running &&
        !cards.length &&
        !error &&
        !waiting.length &&
        !Object.values(results).some(
          (result) => result.status === 'error' || result.status === 'cancelled',
        ) && (
          <Empty
            title={items.length ? '当前筛选下没有结果' : '没有找到这部番剧'}
            action={
              items.length ? (
                <button
                  className="button secondary"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.delete('kind');
                    next.delete('year');
                    setParams(next);
                  }}
                >
                  清除结果筛选
                </button>
              ) : (
                <Link className="button secondary" to="/catalog">
                  去番剧索引看看
                </Link>
              )
            }
          >
            可以切换上方来源，或尝试更短的片名、其他译名。
          </Empty>
        )}
      <div className="search-statuses">
        {Object.entries(results).map(([id, result]) => (
          <div key={id}>
            {(result.status === 'error' || result.status === 'cancelled') && (
              <p className="source-notice">
                <span>
                  {sources.data?.find((s) => s.id === id)?.name}：{result.message}
                </span>
                {sources.data?.find((s) => s.id === id)?.capabilities.includes('catalog') && (
                  <Link className="text-link" to={'/catalog?' + new URLSearchParams({ source: id })}>
                    浏览该源索引
                  </Link>
                )}
                <button
                  className="text-link"
                  disabled={running}
                  onClick={() =>
                    run(
                      { [id]: result.requestedPage ?? 1 },
                      true,
                      result.requestedCursor ? { [id]: result.requestedCursor } : {},
                    )
                  }
                >
                  重试此来源
                </button>
              </p>
            )}
            {result.page?.hasMore && (
              <button
                className="button secondary"
                disabled={running || result.status === 'challenge'}
                onClick={() =>
                  run(
                    { [id]: result.page!.page + 1 },
                    false,
                    result.page!.nextCursor ? { [id]: result.page!.nextCursor } : {},
                  )
                }
              >
                加载更多 {sources.data?.find((s) => s.id === id)?.name} 结果
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function DetailPage() {
  const { sourceId = '', id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [detailEpoch, setDetailEpoch] = useState(0);
  const query = useQuery({
    queryKey: ['detail', sourceId, id, detailEpoch],
    queryFn: ({ signal }) =>
      api<SourceDetail>(
        `/sources/${sourceId}/detail?itemId=${encodeURIComponent(id)}${detailEpoch > 0 ? '&refresh=1' : ''}`,
        { signal },
      ),
  });
  const sources = useSources();
  const library = useLibrary();
  const history = useAnimeHistory({ sourceId, id }, library.data ?? []);
  const client = useQueryClient();
  const toast = useToast();
  const libraryActions = useLibraryActions();
  const historyMutations = useHistoryMutations();
  const [changingLibrary, setChangingLibrary] = useState(false);
  const [lineId, setLineId] = useState<string>(
    (location.state as { preferredLine?: string } | null)?.preferredLine ?? '',
  );
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setLineId((location.state as { preferredLine?: string } | null)?.preferredLine ?? '');
    setExpanded(false);
  }, [sourceId, id, location.key]);
  const data = query.data;
  const returnCandidate = (location.state as { returnTo?: string } | null)?.returnTo;
  const returnTo =
    returnCandidate && /^\/(?:search|catalog|calendar|library|history)(?:\?|$)/.test(returnCandidate)
      ? returnCandidate
      : '/';
  const returnLabel = returnTo.startsWith('/catalog')
    ? '返回番剧索引'
    : returnTo.startsWith('/calendar')
      ? '返回每周放送'
      : returnTo.startsWith('/search')
        ? '返回搜索结果'
        : returnTo.startsWith('/library')
          ? '返回我的番剧'
          : returnTo.startsWith('/history')
            ? '返回观看记录'
            : '返回发现';
  const entry = library.data?.find((e) => e.refs.some((r) => r.sourceId === sourceId && r.id === id));
  const target = data ? continuation(data, history.data ?? [], lineId) : undefined;
  const last = target?.previous;
  const currentLine = target?.line;
  const switchContext = (location.state as { switchContext?: SwitchContext } | null)?.switchContext;
  const linked = Boolean(
    entry?.refs.some(
      (r) => switchContext && r.sourceId === switchContext.card.sourceId && r.id === switchContext.card.id,
    ),
  );
  const matching =
    data && switchContext && (linked || sameAnime(data, switchContext.card)) && currentLine
      ? matchingEpisode(switchContext.episode, currentLine.episodes)
      : undefined;
  const start = matching ?? target?.episode;
  const completionContext = useHistoryContext(start?.locator);
  const favorite = async () => {
    if (!data || changingLibrary) return;
    setChangingLibrary(true);
    try {
      if (entry) await libraryActions.remove(entry);
      else {
        await post('/library', { card: data, status: 'watching' });
        await client.invalidateQueries({ queryKey: ['library'] });
        toast('已加入我的番剧');
      }
    } catch (error) {
      toast(errorText(error));
    } finally {
      setChangingLibrary(false);
    }
  };
  const associate = () => {
    if (!data) return;
    const alternative = sources.data?.find(
      (source) => source.enabled && source.id !== sourceId && source.capabilities.includes('search'),
    );
    navigate(
      '/search?' +
        new URLSearchParams({
          q: data.title,
          linkSource: sourceId,
          linkItem: id,
          ...(entry ? { linkTo: entry.id } : {}),
          ...(alternative ? { source: alternative.id } : {}),
        }),
      { state: { linkBase: data } },
    );
  };
  if (query.isPending) return <Loading label="正在读取番剧和选集…" />;
  if (query.isError || !data)
    return (
      <SourceRecovery sourceId={sourceId} id={id} error={query.error} retry={() => void query.refetch()} />
    );
  return (
    <>
      <Link className="back-link" to={returnTo}>
        <ChevronLeft size={16} />
        {returnLabel}
      </Link>
      <section className="detail-hero">
        <Cover card={data} />
        <div className="detail-copy">
          <span className="source-label">
            {sources.data?.find((s) => s.id === sourceId)?.name ?? sourceId}
          </span>
          <h1>{data.title}</h1>
          <div className="detail-meta">
            {data.year && (
              <Link to={'/catalog?' + new URLSearchParams({ source: sourceId, year: String(data.year) })}>
                {data.year} 年番剧
              </Link>
            )}
            {data.kind !== 'unknown' && <span>{kindLabels[data.kind]}</span>}
            {data.season !== undefined && <span>第 {data.season} 季</span>}
            {data.remarks && <span>{data.remarks}</span>}
          </div>
          <DetailRatings key={refKey(data)} card={data} />
          <p className={expanded ? 'description expanded' : 'description'}>
            {data.description || '这个来源暂时没有提供简介。'}
          </p>
          {(data.description?.length ?? 0) > 160 && (
            <button className="text-link" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起简介' : '展开简介'}
            </button>
          )}
          <div className="detail-actions">
            {history.isPending || library.isPending ? (
              <span className="muted">正在读取进度…</span>
            ) : history.isError ? (
              <button className="button secondary" onClick={() => void history.refetch()}>
                重新读取观看进度
              </button>
            ) : start ? (
              <Link
                className="button primary"
                to={watchPath(
                  sourceId,
                  id,
                  currentLine!.id,
                  start.id,
                  matching ? switchContext!.position : target?.position,
                )}
              >
                <Play size={17} fill="currentColor" />
                {matching
                  ? `继续 · ${matching.label} · ${timeLabel(switchContext!.position)}`
                  : continuationLabel(target!)}
              </Link>
            ) : (
              <span className="muted">
                {currentLine?.episodes.length ? '请选择剧集，进度暂不能唯一对应' : '暂无可选剧集'}
              </span>
            )}
            <button
              className="button secondary"
              disabled={changingLibrary || library.isPending || library.isError}
              onClick={() => {
                void favorite();
              }}
            >
              {entry ? <Check size={17} /> : <Bookmark size={17} />} {entry ? '已追番' : '追番'}
            </button>
          </div>
        </div>
      </section>
      {switchContext && !matching && (
        <div className="info-banner">尚不能确认相同的季度和集数。请手动选择剧集，新来源将从头播放。</div>
      )}
      <section className="section">
        <div className="section-heading">
          <h2>选集</h2>
          <button
            className="text-link"
            onClick={() => {
              setDetailEpoch((n) => n + 1);
            }}
          >
            <RefreshCw size={14} />
            刷新选集
          </button>
        </div>
        <div className="source-tabs">
          {data.lines.map((line) => (
            <button
              className={currentLine?.id === line.id ? 'chip selected' : 'chip'}
              key={line.id}
              onClick={() => setLineId(line.id)}
            >
              {line.name}
              <small>{line.episodes.length}</small>
            </button>
          ))}
        </div>
        {currentLine?.episodes.length ? (
          <EpisodeBrowser
            line={currentLine}
            history={history.data ?? []}
            currentEpisodeId={start?.id}
            episodeHref={(episode) =>
              watchPath(
                sourceId,
                id,
                currentLine.id,
                episode.id,
                matching?.id === episode.id ? switchContext?.position : undefined,
              )
            }
            sourceActions={
              <button className="text-link" onClick={associate}>
                关联其他来源
              </button>
            }
            onSetCompleted={async (episode, completed) => {
              if (!completionContext.data || completionContext.isFetching)
                throw new Error('正在读取进度，请稍后重试');
              const saved = progressForEpisode(episode, currentLine, history.data ?? []);
              const at = new Date().toISOString();
              await historyMutations.complete(
                {
                  card: data,
                  episode,
                  key: episodeKey(episode.locator),
                  position: saved?.position ?? 0,
                  duration: saved?.duration ?? 0,
                  capturedAt: saved?.capturedAt ?? at,
                  updatedAt: saved?.updatedAt ?? at,
                },
                completed,
                completionContext.data.version,
              );
            }}
          />
        ) : (
          <Empty title="暂时没有可播放剧集">可以刷新选集，或查找其他来源。</Empty>
        )}
      </section>
      <section className="section linked-sources">
        <div className="section-heading">
          <h2>其他来源</h2>
          <button
            className="text-link"
            onClick={() => {
              void associate();
            }}
          >
            <Link2 size={15} />
            关联来源
          </button>
        </div>
        {entry && entry.refs.length > 1 ? (
          <div className="source-tabs">
            {entry.refs.map((ref) => (
              <div className="linked-source-item" key={refKey(ref)}>
                <Link className="chip" to={detailPath(ref.sourceId, ref.id)}>
                  {sources.data?.find((s) => s.id === ref.sourceId)?.name ?? ref.sourceId}
                  <ArrowRight size={14} />
                </Link>
                {ref.sourceId !== entry.card.sourceId || ref.id !== entry.card.id ? (
                  <button
                    className="text-link"
                    disabled={changingLibrary}
                    aria-label={`解除 ${sources.data?.find((source) => source.id === ref.sourceId)?.name ?? ref.sourceId} 关联`}
                    onClick={async () => {
                      setChangingLibrary(true);
                      try {
                        await libraryActions.unlink(entry, ref);
                      } catch (error) {
                        toast(errorText(error));
                      } finally {
                        setChangingLibrary(false);
                      }
                    }}
                  >
                    解除关联
                  </button>
                ) : (
                  <small className="muted">主来源</small>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">关联同一部番剧的其他来源，换源时更容易找回正确的集数。</p>
        )}
      </section>
    </>
  );
}

export { LibraryPage } from './library-page';
export { HistoryPage } from './history-page';

export function SettingsPage() {
  const sources = useSources();
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/settings') });
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () =>
      api<{
        validation?: Record<
          string,
          { checkedAt: string; attempted: number; started: number; fullEpisode: boolean; scope: string }
        >;
        events: { at: string; sourceId: string; stage: string; ms: number; ok: boolean; message?: string }[];
      }>('/diagnostics'),
  });
  const action = async (name: string, run: () => Promise<unknown>, message: string) => {
    setBusy(name);
    try {
      await run();
      await Promise.all([
        client.invalidateQueries({ queryKey: ['sources'] }),
        client.invalidateQueries({ queryKey: ['diagnostics'] }),
      ]);
      toast(message);
    } catch (error) {
      toast(errorText(error));
    } finally {
      setBusy('');
    }
  };
  const move = async (source: SourceState, direction: -1 | 1) => {
    const list = sources.data ?? [];
    const index = list.findIndex((s) => s.id === source.id);
    const other = list[index + direction];
    if (!other) return;
    await action(
      source.id,
      async () => {
        await patch(`/sources/${source.id}`, { priority: index + direction });
        await patch(`/sources/${other.id}`, { priority: index });
      },
      '已调整来源顺序',
    );
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>设置</h1>
          <p>让这里更适合你的观看习惯。</p>
        </div>
        <span className="version">v{APP_VERSION} 开发预览</span>
      </div>
      <section className="settings-section appearance-section">
        <div className="section-heading">
          <h2>外观</h2>
          <span className="muted">为白天和夜晚，选一种舒服的颜色</span>
        </div>
        <AppearanceChoices />
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h2>番剧来源</h2>
          <span className="muted">默认来源顺序 · 每次搜索一个选定来源</span>
        </div>
        <p className="section-note">
          目录可访问不代表所有线路可播放。完整播放验证结果会在诊断报告中单独记录。
        </p>
        {sources.isPending ? (
          <Loading />
        ) : sources.isError ? (
          <ErrorState error={sources.error} />
        ) : (
          sources.data?.map((source, index) => (
            <div className="source-row" key={source.id}>
              <span className={`source-emblem ${source.id}`}>{source.name.slice(0, 1)}</span>
              <div className="source-copy">
                <h3>
                  {source.name}
                  {index === 0 && source.enabled && <span className="preferred-source">优先</span>}
                  <small>{source.verification === 'verified' ? '已整集验证' : '待整集验证'}</small>
                </h3>
                <p>{source.description}</p>
                <span className={`source-health ${source.health.status === 'error' ? 'warning-text' : ''}`}>
                  {source.health.status === 'unknown'
                    ? '尚未检查目录'
                    : source.health.status === 'ok'
                      ? `上次请求成功 · ${source.health.latency} ms`
                      : source.health.message}
                </span>
                {diagnostics.data?.validation?.[source.id] && (
                  <p className="validation-note">
                    {diagnostics.data.validation[source.id].checkedAt} 抽测：
                    {diagnostics.data.validation[source.id].started}/
                    {diagnostics.data.validation[source.id].attempted} 集起播 ·{' '}
                    {diagnostics.data.validation[source.id].scope}
                  </p>
                )}
              </div>
              <div className="source-actions">
                <button
                  className="icon-button"
                  aria-label={`提高 ${source.name} 优先级`}
                  disabled={index === 0 || !!busy}
                  onClick={() => {
                    void move(source, -1);
                  }}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`降低 ${source.name} 优先级`}
                  disabled={index === (sources.data?.length ?? 0) - 1 || !!busy}
                  onClick={() => {
                    void move(source, 1);
                  }}
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  className="button secondary small"
                  disabled={!!busy || !source.enabled}
                  onClick={() => {
                    void action(
                      source.id,
                      () => api(`/home?sourceId=${source.id}&refresh=1`),
                      `${source.name} 目录检查完成`,
                    );
                  }}
                >
                  检查目录
                </button>
                <button
                  className={source.enabled ? 'toggle on' : 'toggle'}
                  role="switch"
                  aria-checked={source.enabled}
                  aria-label={`启用 ${source.name}`}
                  disabled={!!busy}
                  onClick={() => {
                    void action(
                      source.id,
                      () =>
                        patch(`/sources/${source.id}`, {
                          enabled: !source.enabled,
                          priority: source.priority,
                        }),
                      source.enabled ? '来源已停用' : '来源已启用',
                    );
                  }}
                >
                  <span />
                </button>
              </div>
            </div>
          ))
        )}
      </section>
      <section className="settings-section">
        <h2>播放习惯</h2>
        <div className="setting-row">
          <div>
            <h3>自动播放下一集</h3>
            <p>当前剧集结束后，继续同一线路的下一集。</p>
          </div>
          <button
            className={settings.data?.autoNext ? 'toggle on' : 'toggle'}
            role="switch"
            aria-checked={settings.data?.autoNext ?? false}
            aria-label="自动播放下一集"
            disabled={!settings.data || !!busy}
            onClick={() => {
              const current = settings.data;
              if (current)
                void action(
                  'settings',
                  async () => {
                    const saved = await putSettings(current, { autoNext: !current.autoNext });
                    client.setQueryData<AppSettings>(['settings'], (latest) => preferSettings(latest, saved));
                  },
                  '播放习惯已保存',
                );
            }}
          >
            <span />
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h2>本地资料</h2>
        <BackupManager />
        <div className="setting-row">
          <div>
            <h3>刷新来源缓存</h3>
            <p>重新获取目录和选集，保留追番与观看记录。</p>
          </div>
          <button
            className="button secondary small"
            disabled={!!busy}
            onClick={() => {
              void action(
                'cache',
                async () => {
                  await post('/cache/clear');
                  await client.invalidateQueries({
                    predicate: (query) =>
                      ['home', 'catalog', 'schedule', 'detail'].includes(String(query.queryKey[0])),
                  });
                },
                '来源缓存已清空',
              );
            }}
          >
            <RefreshCw size={15} />
            清空缓存
          </button>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h2>最近的来源请求</h2>
          <button
            className="text-link"
            onClick={() => {
              void diagnostics.refetch();
            }}
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
        <div className="diagnostics">
          {diagnostics.data?.events.length ? (
            diagnostics.data.events.slice(0, 12).map((event, index) => (
              <div className="diagnostic-row" key={index}>
                <span className={`status-dot ${event.ok ? '' : 'error'}`} />
                <strong>{sources.data?.find((s) => s.id === event.sourceId)?.name ?? event.sourceId}</strong>
                <span>
                  {{ home: '目录', search: '搜索', detail: '详情', resolve: '播放解析' }[event.stage] ??
                    event.stage}
                </span>
                <span>{event.ok ? `${event.ms} ms` : event.message}</span>
                <time>{new Date(event.at).toLocaleTimeString('zh-CN')}</time>
              </div>
            ))
          ) : (
            <p className="muted">使用来源后，这里会显示请求结果。</p>
          )}
        </div>
      </section>
    </>
  );
}
