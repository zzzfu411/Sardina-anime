import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Play, Search, Trash2 } from 'lucide-react';
import { completedEpisode, historyTime } from '../../../packages/core/src/progress';
import {
  type HistoryEntry,
  type HistoryPage as HistoryPageData,
  type LibraryEntry,
  type SourceRef,
  type SourceState,
} from '../../../packages/core/src/types';
import { api, continuePath, timeLabel, watchPath } from './api';
import { useHistoryMutations } from './history';
import { Cover, Empty, ErrorState, Loading } from './ui';
import { dateTime, groupHistory, type HistoryGroup } from './data-management-utils';
import './management.css';

const message = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试');
function selectedRefs(value: string | null): SourceRef[] | undefined {
  if (!value || value.length > 12_000) return;
  try {
    const refs: unknown = JSON.parse(value);
    if (
      Array.isArray(refs) &&
      refs.length > 0 &&
      refs.length <= 30 &&
      refs.every(
        (ref) =>
          ref &&
          typeof ref.sourceId === 'string' &&
          ref.sourceId.length > 0 &&
          ref.sourceId.length <= 100 &&
          typeof ref.id === 'string' &&
          ref.id.length > 0 &&
          ref.id.length <= 500,
      )
    )
      return refs;
  } catch {
    /* Invalid address filters are ignored; no mutation depends on them. */
  }
}

function HistoryRecords({
  group,
  sourceNames,
  busy,
  removeRecord,
}: {
  group: HistoryGroup;
  sourceNames: Map<string, string>;
  busy: boolean;
  removeRecord: (entry: HistoryEntry) => void;
}) {
  const [shown, setShown] = useState(20);
  return (
    <div className="management-history-records">
      {group.entries.slice(0, shown).map((entry) => {
        const finished = completedEpisode(entry);
        const locator = entry.episode.locator;
        return (
          <article className="management-history-record" key={entry.key}>
            <div className="management-history-record-copy">
              <strong>{entry.episode.label}</strong>
              <p>
                {sourceNames.get(locator.sourceId) ?? locator.sourceId} · 线路 {locator.lineId}
              </p>
              <div className="progress" aria-hidden="true">
                <i
                  style={{
                    width: `${finished ? 100 : entry.duration > 0 ? Math.min(100, (entry.position / entry.duration) * 100) : 0}%`,
                  }}
                />
              </div>
              <small>
                {finished ? '已看完' : `看到 ${timeLabel(entry.position)}`}
                {entry.duration > 0 ? ` / ${timeLabel(entry.duration)}` : ''} ·{' '}
                <time dateTime={entry.capturedAt ?? entry.updatedAt}>
                  {dateTime(entry.capturedAt ?? entry.updatedAt)}
                </time>
              </small>
            </div>
            <div className="management-record-actions">
              <Link
                className="button secondary small"
                to={watchPath(
                  locator.sourceId,
                  locator.animeId,
                  locator.lineId,
                  locator.episodeId,
                  finished ? 0 : undefined,
                )}
              >
                <Play size={14} aria-hidden="true" />
                {finished ? '重看本集' : '继续本集'}
              </Link>
              {!finished && (
                <Link
                  className="text-link"
                  to={watchPath(locator.sourceId, locator.animeId, locator.lineId, locator.episodeId, 0)}
                >
                  从头重看
                </Link>
              )}
              <button
                className="icon-button"
                aria-label={`删除 ${entry.card.title} ${entry.episode.label} ${sourceNames.get(locator.sourceId) ?? locator.sourceId} 线路 ${locator.lineId} 的记录`}
                disabled={busy}
                onClick={() => removeRecord(entry)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        );
      })}
      {group.entries.length > shown && (
        <button className="button secondary small" onClick={() => setShown((value) => value + 20)}>
          展开更多分集记录（还有 {group.entries.length - shown} 条已载入）
        </button>
      )}
    </div>
  );
}

export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const query = (params.get('q') ?? '').slice(0, 150);
  const refsValue = params.get('refs');
  const refs = useMemo(() => selectedRefs(refsValue), [refsValue]);
  const library = useQuery({
    queryKey: ['library'],
    queryFn: ({ signal }) => api<LibraryEntry[]>('/library', { signal }),
  });
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: ({ signal }) => api<SourceState[]>('/sources', { signal }),
  });
  const history = useInfiniteQuery({
    queryKey: ['history-page', query, refs],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<HistoryPageData>(
        '/history/page?' +
          new URLSearchParams({
            q: query,
            limit: '50',
            ...(refs ? { refs: JSON.stringify(refs) } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
          }),
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const mutations = useHistoryMutations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const entries = useMemo(() => {
    const unique = new Map<string, HistoryEntry>();
    for (const page of history.data?.pages ?? [])
      for (const entry of page.items) {
        const previous = unique.get(entry.key);
        if (!previous || historyTime(entry) > historyTime(previous)) unique.set(entry.key, entry);
      }
    return [...unique.values()];
  }, [history.data]);
  const groups = useMemo(() => groupHistory(entries, library.data ?? []), [entries, library.data]);
  const total = history.data?.pages[0]?.total ?? 0;
  const sourceNames = new Map(sources.data?.map((source) => [source.id, source.name]));
  const filtered = Boolean(query || refs);
  const updateParams = (values: Record<string, string>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
        return next;
      },
      { replace: true },
    );
  const remove = async (selection: { key?: string; refs?: SourceRef[] }, label: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await mutations.remove(selection);
      setNotice(label);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  };
  const clearAll = () => {
    if (window.confirm('清空全部观看记录？包括当前筛选之外的记录，追番列表会保留。'))
      void remove({}, '全部观看记录已清空');
  };
  const clearGroup = (group: HistoryGroup) => {
    if (
      window.confirm(
        `删除「${group.card.title}」的全部观看记录？包含 ${group.refs.length} 个已关联来源和当前尚未载入的记录，追番列表会保留。`,
      )
    )
      void remove({ refs: group.refs }, `已删除「${group.card.title}」的全部观看记录`);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>观看记录</h1>
          <p>按作品整理每次停留，来源和线路分别保留。</p>
        </div>
        {(total > 0 || filtered) && (
          <button className="button secondary small" disabled={busy} onClick={clearAll}>
            <Trash2 size={15} aria-hidden="true" />
            清空记录
          </button>
        )}
      </div>
      <div className="management-toolbar">
        <label className="management-field management-search">
          <span>搜索观看记录</span>
          <span className="management-search-input">
            <Search size={17} aria-hidden="true" />
            <input
              type="search"
              value={query}
              maxLength={150}
              placeholder="输入片名"
              onChange={(event) => updateParams({ q: event.target.value })}
            />
          </span>
        </label>
        {refs && (
          <div className="management-filter-note">
            <span>仅查看选定作品</span>
            <button className="text-link" onClick={() => updateParams({ refs: '' })}>
              查看全部作品
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="management-inline-error" role="alert">
          {error}
          <button className="text-link" onClick={() => setError('')}>
            收起
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {library.isError && (
        <div className="management-inline-error">
          关联资料暂未载入，记录暂按单一来源分组；载入后才能删除整部记录。
          <button className="text-link" onClick={() => void library.refetch()}>
            重试关联资料
          </button>
        </div>
      )}
      {history.isPending ? (
        <Loading />
      ) : history.isError && !entries.length ? (
        <ErrorState error={history.error} retry={() => void history.refetch()} />
      ) : !entries.length ? (
        <Empty
          title={filtered ? '没有符合条件的观看记录' : '还没有观看记录'}
          action={
            filtered ? (
              <button className="button secondary" onClick={() => updateParams({ q: '', refs: '' })}>
                清除筛选
              </button>
            ) : (
              <Link className="button secondary" to="/">
                发现番剧
              </Link>
            )
          }
        >
          {filtered ? '可以更换片名，或查看全部作品。' : '开始播放后，进度会自动保存在本机。'}
        </Empty>
      ) : (
        <>
          <p className="management-count muted" role="status">
            已载入 {entries.length} / {total} 条记录，当前显示 {groups.length} 部作品。
            {history.hasNextPage && '加载更多会补全作品分组。'}
          </p>
          <div className="management-history-groups">
            {groups.map((group) => {
              const latest = group.entries[0];
              return (
                <section className="management-history-group" key={group.id}>
                  <div className="management-history-heading">
                    <Cover card={group.card} />
                    <div className="management-history-heading-copy">
                      <h2>{group.card.title}</h2>
                      <p>
                        {completedEpisode(latest) ? '已看完 ' : '上次看到 '}
                        {latest.episode.label}
                        {!completedEpisode(latest) && ` · ${timeLabel(latest.position)}`}
                      </p>
                      <small className="muted">
                        <time dateTime={latest.capturedAt ?? latest.updatedAt}>
                          {dateTime(latest.capturedAt ?? latest.updatedAt)}
                        </time>{' '}
                        ·{' '}
                        {group.refs.length > 1
                          ? `${group.refs.length} 个关联来源`
                          : (sourceNames.get(latest.card.sourceId) ?? latest.card.sourceId)}
                      </small>
                    </div>
                    <Link
                      className="button secondary small"
                      to={continuePath(latest.card.sourceId, latest.card.id)}
                    >
                      <Play size={15} aria-hidden="true" />
                      继续观看
                    </Link>
                  </div>
                  <details className="management-history-details" open={Boolean(refs)}>
                    <summary>查看分集与来源记录（已载入 {group.entries.length} 条）</summary>
                    <HistoryRecords
                      group={group}
                      sourceNames={sourceNames}
                      busy={busy}
                      removeRecord={(entry) =>
                        void remove({ key: entry.key }, `已删除 ${entry.episode.label} 的这条记录`)
                      }
                    />
                  </details>
                  <div className="management-history-group-actions">
                    {!refs && (
                      <button
                        className="text-link"
                        onClick={() => updateParams({ refs: JSON.stringify(group.refs) })}
                      >
                        只看这部的全部记录
                      </button>
                    )}
                    <button
                      className="text-link"
                      disabled={busy || library.isPending || library.isError}
                      onClick={() => clearGroup(group)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      删除整部记录
                    </button>
                  </div>
                </section>
              );
            })}
          </div>
          {history.isFetchNextPageError && (
            <ErrorState error={history.error} retry={() => void history.fetchNextPage()} />
          )}
          {history.hasNextPage && (
            <div className="management-pagination">
              <button
                className="button secondary"
                disabled={history.isFetchingNextPage || busy}
                onClick={() => void history.fetchNextPage()}
              >
                {history.isFetchingNextPage ? '正在载入记录…' : '加载更早记录'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
