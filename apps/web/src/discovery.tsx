import { SearchSourcePicker, useSearchSource } from './search-source';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Grid2X2,
  List,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react';
import type {
  CatalogFilter,
  CatalogPage as CatalogData,
  HistoryEntry,
  LibraryEntry,
  ScheduleDay,
  SearchHistoryEntry,
  SourceState,
} from '../../../packages/core/src/types';
import { refKey, statusLabels } from '../../../packages/core/src/types';
import { completedEpisode } from '../../../packages/core/src/progress';
import { pendingUpdateCount } from '../../../packages/core/src/library';
import { weekdays } from '../../../packages/core/src/discovery';
import { api, continuePath, timeLabel } from './api';
import { AnimeTile, Empty, ErrorState, Loading, useToast } from './ui';
import { selectModuleSource, useSourcePreference } from './module-source';
import { personalSchedule } from './personal-schedule';
import './discovery-experience.css';

const useSources = () => useQuery({ queryKey: ['sources'], queryFn: () => api<SourceState[]>('/sources') });
export const resultClass = (view: string | null) => (view === 'list' ? 'browse-list' : 'poster-grid');

export function ViewToggle({ value, onChange }: { value: string | null; onChange: (value: string) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="结果显示方式">
      <button
        className={value !== 'list' ? 'selected' : ''}
        aria-pressed={value !== 'list'}
        aria-label="海报视图"
        onClick={() => onChange('grid')}
      >
        <Grid2X2 size={17} />
      </button>
      <button
        className={value === 'list' ? 'selected' : ''}
        aria-pressed={value === 'list'}
        aria-label="列表视图"
        onClick={() => onChange('list')}
      >
        <List size={18} />
      </button>
    </div>
  );
}

export function DiscoveryEntrances() {
  return (
    <nav className="discovery-entrances" aria-label="找番入口">
      <Link to="/catalog">
        <Grid2X2 size={22} />
        <div>
          <strong>番剧索引</strong>
          <span>按年份、类型和题材找番</span>
        </div>
        <ArrowRight size={17} />
      </Link>
      <Link to="/calendar">
        <CalendarDays size={22} />
        <div>
          <strong>每周放送</strong>
          <span>看看今天有哪些故事</span>
        </div>
        <ArrowRight size={17} />
      </Link>
      <Link to="/catalog?browse=popular">
        <TrendingUp size={22} />
        <div>
          <strong>热门与高分</strong>
          <span>按来源热度与评分挑选</span>
        </div>
        <ArrowRight size={17} />
      </Link>
    </nav>
  );
}

export function SearchLanding() {
  const selection = useSearchSource();
  const history = useQuery({
    queryKey: ['search-history'],
    queryFn: () => api<SearchHistoryEntry[]>('/search-history'),
    staleTime: 0,
  });
  const sources = useSources();
  const client = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const remove = async (keyword?: string) => {
    setDeleting(true);
    try {
      const entries = await api<SearchHistoryEntry[]>(
        '/search-history' + (keyword ? '?keyword=' + encodeURIComponent(keyword) : ''),
        { method: 'DELETE' },
      );
      client.setQueryData(['search-history'], entries);
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败，请重试');
    } finally {
      setDeleting(false);
    }
  };
  const thematic = sources.data?.find((s) => s.enabled && s.catalogFilters?.some((f) => f.key === 'genre'));
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>找一部想看的番剧</h1>
          <p>先选来源，再输入片名搜索；也可以从题材或放送安排开始。</p>
        </div>
      </div>
      <SearchSourcePicker />
      <DiscoveryEntrances />
      <section className="section recent-searches">
        <div className="section-heading">
          <h2>
            <Clock3 size={19} /> 最近搜索
          </h2>
          {Boolean(history.data?.length) && (
            <button className="text-link" disabled={deleting} onClick={() => void remove()}>
              <Trash2 size={15} />
              清空搜索记录
            </button>
          )}
        </div>
        {history.isError ? (
          <ErrorState error={history.error} retry={() => void history.refetch()} />
        ) : history.isPending ? (
          <Loading label="正在读取搜索记录…" />
        ) : history.data.length ? (
          <div className="recent-query-list">
            {history.data.map((entry) => (
              <div className="recent-query" key={entry.keyword}>
                <Link
                  to={
                    '/search?' +
                    new URLSearchParams({
                      q: entry.keyword,
                      ...(selection.source ? { source: selection.source.id } : {}),
                    })
                  }
                >
                  <Search size={14} />
                  {entry.keyword}
                </Link>
                <button
                  aria-label={'删除搜索 ' + entry.keyword}
                  disabled={deleting}
                  onClick={() => void remove(entry.keyword)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">搜索过的片名会保存在这里，方便下次接着找。</p>
        )}
      </section>
      {thematic && (
        <section className="section">
          <div className="section-heading">
            <h2>按心情选一部</h2>
            <span className="muted">{thematic.name}</span>
          </div>
          <div className="genre-entries">
            {thematic.catalogFilters
              ?.find((f) => f.key === 'genre')
              ?.options.filter((o) => o.value)
              .map((option) => (
                <Link
                  key={option.value}
                  to={'/catalog?' + new URLSearchParams({ source: thematic.id, genre: option.value })}
                >
                  {option.label}
                  <ArrowRight size={14} />
                </Link>
              ))}
          </div>
        </section>
      )}
    </>
  );
}

function FilterRow({
  filter,
  value,
  onChange,
}: {
  filter: CatalogFilter;
  value: string;
  onChange: (value: string) => void;
}) {
  const years = filter.key === 'year';
  const visible = years ? filter.options.slice(0, 8) : filter.options;
  return (
    <div className="catalog-filter-row" role="group" aria-label={filter.label + '筛选'}>
      <span className="filter-name">{filter.label}</span>
      <div className="filter-values">
        {visible.map((option) => (
          <button
            key={option.value}
            className={value === option.value ? 'filter-option selected' : 'filter-option'}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
        {years && (
          <select
            aria-label="更多年份"
            value={visible.some((o) => o.value === value) ? '' : value}
            onChange={(e) => {
              if (e.target.value) onChange(e.target.value);
            }}
          >
            <option value="">更多年份</option>
            {filter.options.slice(8).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

export function CatalogPage() {
  const sources = useSources();
  const [showFilters, setShowFilters] = useState(false);
  const [params, setParams] = useSearchParams();
  const [preferredSource, rememberSource, preferenceReady] = useSourcePreference('catalog');
  const popular = params.get('browse') === 'popular';
  const heatSort = (source: SourceState) =>
    source.catalogFilters
      ?.find((f) => f.key === 'sort')
      ?.options.find((o) => ['hits', '最热'].includes(o.value))?.value;
  const eligible =
    sources.data?.filter(
      (s) => s.enabled && s.capabilities.includes('catalog') && (!popular || heatSort(s)),
    ) ?? [];
  const source = selectModuleSource(eligible, params.get('source'), preferredSource) ??
    selectModuleSource(eligible, null, preferredSource);
  const requestedSource = params.get('source');
  useEffect(() => {
    if (requestedSource && source?.id === requestedSource) rememberSource(requestedSource);
  }, [requestedSource, source?.id, rememberSource]);
  const page = Math.max(1, Math.min(1000, Math.trunc(Number(params.get('page'))) || 1));
  const cursor = params.get('cursor') ?? '';
  const view = params.get('view');
  const definitions = source?.catalogFilters ?? [];
  const filters = Object.fromEntries(
    definitions
      .map((f) => [
        f.key,
        params.get(f.key) ?? (popular && f.key === 'sort' ? heatSort(source!) : f.defaultValue) ?? '',
      ])
      .filter(([, value]) => value),
  );
  const filterKey = JSON.stringify(filters);
  const forceRefresh = useRef(false);
  const query = useQuery({
    queryKey: ['catalog', source?.id, page, filterKey, cursor],
    enabled: Boolean(source && (preferenceReady || requestedSource)),
    staleTime: 300_000,
    retry: 0,
    queryFn: ({ signal }) => {
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      return api<CatalogData>(
        '/catalog?' +
          new URLSearchParams({
            sourceId: source!.id,
            page: String(page),
            filters: filterKey,
            ...(cursor ? { cursor } : {}),
            ...(refresh ? { refresh: '1' } : {}),
          }),
        { signal },
      );
    },
  });
  const [jump, setJump] = useState('');
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (key === 'source') {
      rememberSource(value);
      for (const f of definitions) next.delete(f.key);
    }
    next.set('source', key === 'source' ? value : source!.id);
    value ? next.set(key, value) : next.delete(key);
    if (key !== 'page' && key !== 'view') {
      next.delete('page');
      next.delete('cursor');
      next.delete('trail');
    }
    if (key === 'page' && source?.catalogPagination === 'cursor') {
      const trail = (params.get('trail') ?? '')
        .split(',')
        .filter((value) => /^\d{1,12}$/.test(value))
        .slice(0, 1000);
      if (Number(value) > page) {
        if (!query.data?.nextCursor) return;
        trail.push(cursor || '0');
        next.set('cursor', query.data.nextCursor);
      } else {
        const previous = trail.pop() ?? '0';
        if (Number(value) === 1) next.delete('cursor');
        else next.set('cursor', previous);
      }
      trail.length ? next.set('trail', trail.join(',')) : next.delete('trail');
    }
    setParams(next);
  };
  const reset = () =>
    setParams({ source: source!.id, ...(popular ? { browse: 'popular' } : {}), ...(view ? { view } : {}) });
  const active = definitions.filter((f) => filters[f.key] && filters[f.key] !== f.defaultValue);
  const sort = definitions.find((f) => f.key === 'sort');
  if (sources.isPending || (!preferenceReady && !requestedSource)) return <Loading />;
  if (sources.isError) return <ErrorState error={sources.error} retry={() => void sources.refetch()} />;
  if (!source)
    return (
      <Empty
        title={popular ? '还没有启用支持热度排序的来源' : '还没有启用支持索引的来源'}
        action={
          <Link className="button secondary" to="/settings">
            管理来源
          </Link>
        }
      >
        启用 AniCh 或 AkiAnime 后，可以按分类浏览番剧。
      </Empty>
    );
  return (
    <div className="catalog-page">
      <div className="page-heading">
        <div>
          <h1>{popular ? '热门与高分' : '番剧索引'}</h1>
          <p>
            {popular
              ? '由当前来源提供热度与评分顺序，不同来源分别浏览。'
              : '从类型、年份或题材出发，慢慢挑一部。'}
          </p>
        </div>
        <button
          className="button secondary small"
          disabled={query.isFetching}
          onClick={() => {
            forceRefresh.current = true;
            void query.refetch();
          }}
        >
          <RefreshCw size={16} />
          刷新目录
        </button>
      </div>
      {sort && (
        <nav className="catalog-orders" aria-label="快捷排序">
          {sort.options.map((option) => (
            <button
              key={option.value}
              className={filters.sort === option.value ? 'selected' : ''}
              aria-pressed={filters.sort === option.value}
              onClick={() => change('sort', option.value)}
            >
              {option.label}
            </button>
          ))}
        </nav>
      )}
      <section className="catalog-filters" aria-label="番剧筛选">
        <div className="catalog-filter-row">
          <span className="filter-name">索引来源</span>
          <select className="catalog-source-select" aria-label="当前索引来源" value={source.id}
            onChange={(event) => change('source', event.target.value)}>
            {eligible.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <div className="filter-values catalog-source-options">
            {eligible.map((s) => (
              <button
                key={s.id}
                aria-pressed={source.id === s.id}
                className={source.id === s.id ? 'filter-option selected' : 'filter-option'}
                onClick={() => change('source', s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
        <button
          className="filter-disclosure"
          aria-expanded={showFilters}
          aria-controls="catalog-filter-body"
          onClick={() => setShowFilters(!showFilters)}
        >
          <SlidersHorizontal size={16} />
          {showFilters ? '收起筛选条件' : '展开筛选条件'}
          <span>{active.length ? `${active.length} 项已选` : '类型、年份、题材'}</span>
        </button>
        <div id="catalog-filter-body" className={`catalog-filter-body ${showFilters ? 'expanded' : ''}`}>
          {definitions
            .filter((f) => f.key !== 'sort')
            .map((filter) => (
              <FilterRow
                key={source.id + filter.key}
                filter={filter}
                value={filters[filter.key] ?? ''}
                onChange={(value) => change(filter.key, value)}
              />
            ))}
        </div>
        {active.length > 0 && (
          <div className="active-filters">
            <span>已选</span>
            {active.map((f) => (
              <button
                key={f.key}
                aria-label={'移除' + f.label + '筛选'}
                onClick={() => change(f.key, f.defaultValue ?? '')}
              >
                {f.label}：{f.options.find((o) => o.value === filters[f.key])?.label ?? filters[f.key]}
                <X size={13} />
              </button>
            ))}
            <button className="clear-filters" onClick={reset}>
              重置筛选
            </button>
          </div>
        )}
      </section>
      <details className="catalog-order-note">
        <summary>来源与排序说明</summary>
        <p>当前仅浏览 {source.name}。筛选和排序由该来源提供；未公开的统计周期无法比较，站内评分与 Bangumi 官方排名分别显示。</p>
      </details>
      <div className="results-toolbar">
        <div aria-live="polite">
          <strong>
            {query.data
              ? query.data.total === undefined
                ? `第 ${page} 页 · ${query.data.items.length} 部番剧`
                : `${query.data.total} 个筛选结果`
              : query.isError
                ? '目录暂不可用'
                : '正在查找番剧…'}
          </strong>
          <span className="results-provenance">
            {source.name} · {sort ? '筛选与排序由来源提供' : '按来源目录顺序'}
          </span>
        </div>
        <div className="results-tools">
          {sort && (
            <select
              aria-label="目录排序"
              value={filters.sort || sort.defaultValue}
              onChange={(e) => change('sort', e.target.value)}
            >
              {sort.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <ViewToggle value={view} onChange={(value) => change('view', value)} />
        </div>
      </div>
      {query.isPending ? (
        <Loading label="正在读取来源片库…" />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <div className={resultClass(view)}>
            {query.data.items.map((card) => (
              <AnimeTile
                key={card.id}
                card={card}
                sourceName={source.name}
                showDescription={view === 'list'}
              />
            ))}
          </div>
          {!query.data.items.length && (
            <Empty
              title="这个组合暂时没有番剧"
              action={
                <button className="button secondary" onClick={reset}>
                  重置筛选
                </button>
              }
            >
              试试放宽年份或题材，也可以切换来源。
            </Empty>
          )}
          <nav className="pagination" aria-label="目录分页">
            <button
              className="button secondary small"
              disabled={page <= 1 || query.isFetching}
              onClick={() => change('page', String(page - 1))}
            >
              <ChevronLeft size={16} />
              上一页
            </button>
            <span>
              第 {page} 页{query.data.pageCount ? ` / 共 ${query.data.pageCount} 页` : ''}
            </span>
            <button
              className="button secondary small"
              disabled={!query.data.hasMore || page >= 1000 || query.isFetching}
              onClick={() => change('page', String(page + 1))}
            >
              下一页
              <ChevronRight size={16} />
            </button>
            {source.catalogPagination !== 'cursor' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const target = Number(jump);
                  if (
                    Number.isInteger(target) &&
                    target >= 1 &&
                    target <= Math.min(query.data?.pageCount || 1000, 1000)
                  ) {
                    change('page', String(target));
                    setJump('');
                  }
                }}
              >
                <input
                  type="number"
                  min="1"
                  max={Math.min(query.data.pageCount || 1000, 1000)}
                  aria-label="跳转页码"
                  placeholder="页码"
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                />
                <button className="text-link" type="submit">
                  跳转
                </button>
              </form>
            )}
          </nav>
        </>
      )}
    </div>
  );
}

export function SchedulePanel({ compact = false }: { compact?: boolean }) {
  const sources = useSources();
  const [params, setParams] = useSearchParams();
  const today = new Date().getDay() || 7;
  const [localDay, setLocalDay] = useState(today);
  const [localMine, setLocalMine] = useState(false);
  const [preferredSource, rememberSource, preferenceReady] = useSourcePreference('schedule');
  const requested = Number(params.get('day'));
  const day = compact
    ? localDay
    : Number.isInteger(requested) && requested >= 1 && requested <= 7
      ? requested
      : today;
  const eligible = sources.data?.filter((s) => s.enabled && s.capabilities.includes('schedule')) ?? [];
  const requestedSource = compact ? null : params.get('source');
  const source = selectModuleSource(eligible, requestedSource, preferredSource) ??
    selectModuleSource(eligible, null, preferredSource);
  useEffect(() => {
    if (requestedSource && source?.id === requestedSource) rememberSource(requestedSource);
  }, [requestedSource, source?.id, rememberSource]);
  const onlyMine = compact ? localMine : params.get('mine') === '1';
  const library = useQuery({ queryKey: ['library'], queryFn: () => api<LibraryEntry[]>('/library') });
  const history = useQuery({ queryKey: ['history-recent'], queryFn: () => api<HistoryEntry[]>('/history/recent') });
  const personal = useMemo(() => personalSchedule(library.data ?? [], history.data ?? []), [library.data, history.data]);
  const forceRefresh = useRef(false);
  const query = useQuery({
    queryKey: ['schedule', source?.id, day],
    enabled: Boolean(source && (preferenceReady || requestedSource)),
    staleTime: 300_000,
    retry: 0,
    queryFn: ({ signal }) => {
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      return api<ScheduleDay>(
        '/schedule?' +
          new URLSearchParams({
            sourceId: source!.id,
            weekday: String(day),
            ...(refresh ? { refresh: '1' } : {}),
          }),
        { signal },
      );
    },
  });
  const items = query.data?.items.filter((card) => !onlyMine || personal(card).entry) ?? [];
  if (compact && !source) return null;
  const change = (weekday: number) => {
    if (compact) setLocalDay(weekday);
    else {
      const next = new URLSearchParams(params);
      next.set('day', String(weekday)); next.set('source', source!.id);
      setParams(next);
    }
  };
  const changeMine = (mine: boolean) => {
    if (compact) setLocalMine(mine);
    else {
      const next = new URLSearchParams(params);
      mine ? next.set('mine', '1') : next.delete('mine');
      next.set('source', source!.id); next.set('day', String(day));
      setParams(next);
    }
  };
  return (
    <section className={'schedule-section ' + (compact ? 'section' : '')}>
      <div className={compact ? 'section-heading' : 'page-heading'}>
        <div>
          {compact ? <h2>每周放送</h2> : <h1>每周放送</h1>}
          {!compact && <p>按星期找番，安排这一周的观看清单。</p>}
        </div>
        {compact ? (
          <Link
            className="text-link"
            to={'/calendar?' + new URLSearchParams({ day: String(day), source: source!.id, ...(onlyMine ? { mine: '1' } : {}) })}
          >
            完整周期表
            <ArrowRight size={15} />
          </Link>
        ) : (
          <button
            className="button secondary small"
            disabled={!source || query.isFetching}
            onClick={() => {
              forceRefresh.current = true;
              void query.refetch();
            }}
          >
            <RefreshCw size={15} />
            刷新安排
          </button>
        )}
      </div>
      {sources.isError ? (
        <ErrorState error={sources.error} retry={() => void sources.refetch()} />
      ) : sources.isPending ? (
        <Loading />
      ) : !source ? (
        <Empty
          title="暂无已启用的周期表来源"
          action={
            <Link className="button secondary" to="/settings">
              管理来源
            </Link>
          }
        >
          girigiri 和 AkiAnime 提供按星期分组的放送安排。
        </Empty>
      ) : (
        <>
          <div className="schedule-personal-tools">
            <label>
              <span>当前放送来源</span>
              <select aria-label="周期表来源" value={source.id} onChange={(event) => {
                rememberSource(event.target.value);
                if (!compact) {
                  const next = new URLSearchParams(params);
                  next.set('source', event.target.value); next.set('day', String(day));
                  setParams(next);
                }
              }}>
                {eligible.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <button type="button" className={onlyMine ? 'chip selected' : 'chip'}
              aria-pressed={onlyMine} onClick={() => changeMine(!onlyMine)}>只看我的追番</button>
          </div>
          <div className="week-tabs" role="tablist" aria-label="放送星期">
            {weekdays.map((label, i) => (
              <button
                key={label}
                role="tab"
                id={`weekday-${compact ? 'home' : 'full'}-${i + 1}`}
                aria-controls={`schedule-${compact ? 'home' : 'full'}`}
                aria-selected={day === i + 1}
                tabIndex={day === i + 1 ? 0 : -1}
                className={day === i + 1 ? 'selected' : ''}
                onClick={() => change(i + 1)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? ((i + 1) % 7) + 1
                      : event.key === 'ArrowLeft'
                        ? ((i + 6) % 7) + 1
                        : event.key === 'Home'
                          ? 1
                          : event.key === 'End'
                            ? 7
                            : undefined;
                  if (next === undefined) return;
                  event.preventDefault();
                  change(next);
                  document.getElementById(`weekday-${compact ? 'home' : 'full'}-${next}`)?.focus();
                }}
              >
                <span>{label}</span>
                {today === i + 1 && <small>今天</small>}
              </button>
            ))}
          </div>
          <p className="schedule-note">{source.name} 的来源排期，不代表已经更新。实际更新与可播放集数以详情页为准；新增条目提醒来自资料库检查，观看位置独立记录。</p>
          {library.isError && !onlyMine && <p className="schedule-personal-notice" role="status">
            暂未读取你的追番。<button className="text-link" onClick={() => void library.refetch()}>重试读取</button>
          </p>}
          {history.isError && <p className="schedule-personal-notice" role="status">
            暂未读取观看位置。<button className="text-link" onClick={() => void history.refetch()}>重试读取</button>
          </p>}
          <div
            role="tabpanel"
            id={`schedule-${compact ? 'home' : 'full'}`}
            aria-labelledby={`weekday-${compact ? 'home' : 'full'}-${day}`}
          >
            {query.isPending || (onlyMine && library.isPending) ? (
              <Loading label="正在读取放送安排…" />
            ) : query.isError ? (
              <ErrorState error={query.error} retry={() => void query.refetch()} />
            ) : onlyMine && library.isError ? (
              <ErrorState error={library.error} retry={() => void library.refetch()} />
            ) : items.length ? (
              <div className="poster-grid">
                {(compact ? items.slice(0, 6) : items).map((card) => {
                  const { entry, progress } = personal(card);
                  const additions = entry ? pendingUpdateCount(entry) : 0;
                  return <AnimeTile key={refKey(card)} card={card} sourceName={source.name} action={entry ? (
                    <div className="schedule-personal-card">
                      <span>{statusLabels[entry.status]}{additions ? ` · ${additions} 条新增提醒待查看` : ''}</span>
                      {entry.updates?.length ? <span className="schedule-update-labels">
                        关联来源检测到：{entry.updates.slice(0, 3).map((item) => item.label).join('、')}{entry.updates.length > 3 ? '…' : ''}
                      </span> : null}
                      {progress && <span>上次：{progress.episode.label} · {completedEpisode(progress) ? '已看完' : timeLabel(progress.position)}</span>}
                      <Link className="button secondary small" to={continuePath(card.sourceId, card.id)}
                        state={{ returnTo: '/calendar?' + new URLSearchParams({ source: source.id, day: String(day), ...(onlyMine ? { mine: '1' } : {}) }) }}>
                        {progress && !completedEpisode(progress) ? '继续观看' : '打开观看'}<ArrowRight size={14} aria-hidden="true" />
                      </Link>
                    </div>
                  ) : undefined} />;
                })}
              </div>
            ) : onlyMine ? (
              <Empty title={library.data?.length ? `${weekdays[day - 1]}未列出你的追番` : '资料库还没有追番'}
                action={<button className="button secondary" onClick={() => changeMine(false)}>查看全部放送安排</button>}>
                {library.data?.length ? '仅匹配已关联的来源条目，不推测同名作品。可以切换日期或放送来源。' : '在番剧详情加入追番后，这里会从来源排期中筛出你的作品。'}
              </Empty>
            ) : (
              <Empty title={`${weekdays[day - 1]}暂未列出番剧`}>可以看看其他日期，或去番剧索引找一部。</Empty>
            )}
          </div>
          {!compact && query.data && (
            <p className="schedule-note">
              {onlyMine ? `${items.length} 部我的追番 / ` : ''}{query.data.items.length} 部来源条目 · 读取于{' '}
              {new Date(query.data.checkedAt).toLocaleString('zh-CN')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
export function CalendarPage() {
  return <SchedulePanel />;
}
