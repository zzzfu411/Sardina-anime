import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, LayoutGrid, List, Play, RefreshCw, Search } from 'lucide-react';
import {
  statusLabels,
  type HistoryEntry,
  type LibraryCheckJob,
  type LibraryEntry,
  type SourceState,
  type WatchStatus,
} from '../../../packages/core/src/types';
import { completedEpisode } from '../../../packages/core/src/progress';
import { pendingUpdateCount } from '../../../packages/core/src/library';
import { api, continuePath, detailPath, patch, post, timeLabel } from './api';
import { AnimeTile, Cover, Empty, ErrorState, Loading, useToast } from './ui';
import {
  dateTime,
  filterLibrary,
  latestForLibrary,
  LIBRARY_BATCH_LIMIT,
  LIBRARY_PAGE_SIZE,
  type LibrarySort,
} from './data-management-utils';
import './management.css';

const message = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试');
const sorts: Record<LibrarySort, string> = {
  watched: '最近观看',
  updated: '最近剧集更新',
  added: '最近加入',
  title: '片名',
};

export function LibraryPage() {
  const library = useQuery({
    queryKey: ['library'],
    queryFn: ({ signal }) => api<LibraryEntry[]>('/library', { signal }),
  });
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: ({ signal }) => api<SourceState[]>('/sources', { signal }),
  });
  const history = useQuery({
    queryKey: ['history-recent'],
    queryFn: ({ signal }) => api<HistoryEntry[]>('/history/recent', { signal }),
  });
  const client = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [busy, setBusy] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [batchStatus, setBatchStatus] = useState<WatchStatus>('watching');
  const [batchResult, setBatchResult] = useState('');
  const [operationError, setOperationError] = useState('');
  const notifiedJob = useRef('');
  const completedJob = useRef('');
  const status = params.get('status');
  const filter = status && Object.hasOwn(statusLabels, status) ? (status as WatchStatus) : 'all';
  const sort =
    params.get('sort') && Object.hasOwn(sorts, params.get('sort')!)
      ? (params.get('sort') as LibrarySort)
      : 'watched';
  const query = (params.get('q') ?? '').slice(0, 150);
  const updatesOnly = params.get('updates') === '1';
  const listView = params.get('view') === 'list';
  const checkJob = useQuery({
    queryKey: ['library-check'],
    queryFn: ({ signal }) => api<LibraryCheckJob | null>('/library/check/status', { signal }),
    refetchInterval: (query) => (query.state.data?.running ? 700 : false),
    refetchOnWindowFocus: true,
  });
  const job = checkJob.data;
  const checking = Boolean(job?.running) || busy === 'check';
  const latest = useMemo(
    () => latestForLibrary(history.data ?? [], library.data ?? []),
    [history.data, library.data],
  );
  const items = useMemo(
    () => filterLibrary(library.data ?? [], { query, status: filter, updatesOnly, sort }, latest),
    [library.data, query, filter, updatesOnly, sort, latest],
  );
  const pageCount = Math.max(1, Math.ceil(items.length / LIBRARY_PAGE_SIZE));
  const page = Math.max(1, Math.min(pageCount, Number.parseInt(params.get('page') ?? '1', 10) || 1));
  const visible = items.slice((page - 1) * LIBRARY_PAGE_SIZE, page * LIBRARY_PAGE_SIZE);
  const sourceNames = new Map(sources.data?.map((source) => [source.id, source.name]));
  const updateParams = (values: Record<string, string>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key);
        if (!('page' in values)) next.delete('page');
        return next;
      },
      { replace: true },
    );

  useEffect(() => {
    if (!job || job.running || completedJob.current === job.id) return;
    completedJob.current = job.id;
    void client.invalidateQueries({ queryKey: ['library'] });
    if (notifiedJob.current === job.id)
      toast(
        `检查结束：成功 ${job.succeeded} 项，失败 ${job.failed} 项${job.skipped ? `，跳过 ${job.skipped} 项` : ''}`,
      );
  }, [job, client, toast]);
  useEffect(() => {
    if (!library.data) return;
    const available = new Set(library.data.map((entry) => entry.id));
    setSelection((previous) => {
      const next = new Set([...previous].filter((id) => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [library.data]);

  const check = async (id?: string) => {
    setBusy('check');
    setOperationError('');
    try {
      const result = await post<LibraryCheckJob>('/library/check/start', id ? { id } : {});
      notifiedJob.current = result.id;
      client.setQueryData(['library-check'], result);
    } catch (error) {
      setOperationError(message(error));
    } finally {
      setBusy('');
    }
  };
  const updateStatus = async (entry: LibraryEntry, nextStatus: WatchStatus) => {
    setBusy(entry.id);
    setOperationError('');
    try {
      await patch(`/library/${encodeURIComponent(entry.id)}`, {
        status: nextStatus,
        revision: entry.revision,
      });
      await client.invalidateQueries({ queryKey: ['library'] });
    } catch (error) {
      setOperationError(message(error));
      await client.invalidateQueries({ queryKey: ['library'] });
    } finally {
      setBusy('');
    }
  };
  const acknowledge = async (entry: LibraryEntry) => {
    setBusy(entry.id);
    setOperationError('');
    try {
      await patch(`/library/${encodeURIComponent(entry.id)}`, { markSeen: true, revision: entry.revision });
      await client.invalidateQueries({ queryKey: ['library'] });
      toast('已标记更新提醒为已查看，观看进度保持原样');
    } catch (error) {
      setOperationError(message(error));
      await client.invalidateQueries({ queryKey: ['library'] });
    } finally {
      setBusy('');
    }
  };
  const batchUpdate = async () => {
    const pending = (library.data ?? [])
      .filter((entry) => selection.has(entry.id))
      .slice(0, LIBRARY_BATCH_LIMIT);
    if (!pending.length) return;
    setBusy('batch');
    setBatchResult('');
    setOperationError('');
    const failures: { title: string; message: string }[] = [];
    const succeeded = new Set<string>();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (cursor < pending.length) {
          const entry = pending[cursor++];
          try {
            await patch(`/library/${encodeURIComponent(entry.id)}`, {
              status: batchStatus,
              revision: entry.revision,
            });
            succeeded.add(entry.id);
          } catch (error) {
            failures.push({ title: entry.card.title, message: message(error) });
          }
          setBatchResult(`已处理 ${succeeded.size + failures.length} / ${pending.length} 项`);
        }
      }),
    );
    await client.invalidateQueries({ queryKey: ['library'] });
    setSelection((previous) => new Set([...previous].filter((id) => !succeeded.has(id))));
    setBatchResult(
      `已将 ${succeeded.size} 项设为「${statusLabels[batchStatus]}」${failures.length ? `，${failures.length} 项失败并保留选中` : ''}`,
    );
    if (failures.length)
      setOperationError(failures.map((item) => `${item.title}：${item.message}`).join('；'));
    setBusy('');
  };
  const toggle = (id: string) =>
    setSelection((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < LIBRARY_BATCH_LIMIT) next.add(id);
      return next;
    });
  const toolsFor = (entry: LibraryEntry) => {
    const progress = latest.get(entry.id);
    const count = pendingUpdateCount(entry);
    return (
      <div className="library-management-tools">
        <Link
          className="button secondary small"
          to={continuePath(entry.card.sourceId, entry.card.id)}
          state={{ returnTo: location.pathname + location.search }}
        >
          <Play size={15} aria-hidden="true" />
          {history.isPending || history.isError ? '打开观看' : progress ? '继续观看' : '开始观看'}
        </Link>
        {progress && (
          <small className="muted">
            {completedEpisode(progress)
              ? `已看完 ${progress.episode.label}`
              : `${progress.episode.label} · ${timeLabel(progress.position)}`}
          </small>
        )}
        <label className="management-field compact">
          <span className="visually-hidden">{entry.card.title}的追番状态</span>
          <select
            aria-label={`${entry.card.title}的追番状态`}
            value={entry.status}
            disabled={!!busy}
            onChange={(event) => void updateStatus(entry, event.target.value as WatchStatus)}
          >
            {Object.entries(statusLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {count > 0 && (
          <details className="library-updates">
            <summary>新增 {count} 个剧集条目</summary>
            {entry.updates?.length ? (
              <ul>
                {entry.updates.map((update) => (
                  <li key={update.key}>
                    <Link
                      to={detailPath(update.sourceId, update.id)}
                      state={{ returnTo: location.pathname + location.search }}
                    >
                      {update.label}
                    </Link>
                    <small>{sourceNames.get(update.sourceId) ?? update.sourceId}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">旧版提醒尚无剧集清单，下次检查会建立条目记录。</p>
            )}
            {!!entry.unidentifiedUpdateCount && !!entry.updates?.length && (
              <p className="muted">另有 {entry.unidentifiedUpdateCount} 个旧版更新条目，没有保存具体集名。</p>
            )}
            <button className="text-link" disabled={!!busy} onClick={() => void acknowledge(entry)}>
              <CheckCheck size={15} aria-hidden="true" />
              标记更新已查看
            </button>
          </details>
        )}
        <small className="muted">
          {entry.checkedAt ? `检查于 ${dateTime(entry.checkedAt)}` : '尚未检查更新'}
        </small>
        {entry.updateError && (
          <div className="management-inline-error">
            <span>{entry.updateError}</span>
            <button className="text-link" disabled={checking || !!busy} onClick={() => void check(entry.id)}>
              重试此番剧
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>我的番剧</h1>
          <p>找回上次停留的地方，也看看新一话来了没有。</p>
        </div>
        <button
          className="button secondary small"
          disabled={checking || !!busy || !library.data?.length}
          onClick={() => void check()}
        >
          <RefreshCw className={checking ? 'spin' : ''} size={16} aria-hidden="true" />
          {checking ? '正在检查' : '检查更新'}
        </button>
      </div>
      <div className="source-tabs management-status-tabs" aria-label="追番状态">
        <button
          className={filter === 'all' ? 'chip selected' : 'chip'}
          aria-pressed={filter === 'all'}
          onClick={() => updateParams({ status: '' })}
        >
          全部 {library.data?.length ?? 0}
        </button>
        {Object.entries(statusLabels).map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? 'chip selected' : 'chip'}
            aria-pressed={filter === key}
            onClick={() => updateParams({ status: key })}
          >
            {label} {library.data?.filter((entry) => entry.status === key).length ?? 0}
          </button>
        ))}
      </div>
      <div className="management-toolbar">
        <label className="management-field management-search">
          <span>库内搜索</span>
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
        <label className="management-field">
          <span>排序</span>
          <select value={sort} onChange={(event) => updateParams({ sort: event.target.value })}>
            {Object.entries(sorts).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="management-check">
          <input
            type="checkbox"
            checked={updatesOnly}
            onChange={(event) => updateParams({ updates: event.target.checked ? '1' : '' })}
          />
          只看有更新
        </label>
        <div className="management-view" aria-label="资料库视图">
          <button
            className={listView ? 'icon-button' : 'icon-button selected'}
            aria-label="海报视图"
            aria-pressed={!listView}
            onClick={() => updateParams({ view: '' })}
          >
            <LayoutGrid size={18} />
          </button>
          <button
            className={listView ? 'icon-button selected' : 'icon-button'}
            aria-label="列表视图"
            aria-pressed={listView}
            onClick={() => updateParams({ view: 'list' })}
          >
            <List size={18} />
          </button>
        </div>
      </div>
      {job && (
        <div className="management-check-summary" role="status" aria-live="polite">
          <div>
            {job.running
              ? `已检查 ${job.completed} / ${job.total} 项`
              : `上次检查：成功 ${job.succeeded} 项，失败 ${job.failed} 项${job.skipped ? `，跳过 ${job.skipped} 项` : ''}`}
            <small>
              {job.running
                ? '批量检查想看、在看和暂停的番剧，可离开此页面。'
                : dateTime(job.finishedAt ?? job.startedAt)}
            </small>
          </div>
          {job.running && (
            <progress value={job.completed} max={Math.max(1, job.total)} aria-label="更新检查进度" />
          )}
          {!!job.failed && (
            <details>
              <summary>查看未完成的检查</summary>
              <ul>
                {job.items
                  .filter((item) => item.status === 'failed')
                  .map((item) => (
                    <li key={item.id}>
                      <span>
                        {item.title}：{item.message || '检查失败'}
                      </span>
                      <button
                        className="text-link"
                        disabled={checking || !!busy}
                        onClick={() => void check(item.id)}
                      >
                        重试
                      </button>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {checkJob.isError && (
        <div className="management-inline-error" role="alert">
          无法获取检查任务状态：{message(checkJob.error)}
          <button className="text-link" onClick={() => void checkJob.refetch()}>
            重新读取
          </button>
        </div>
      )}
      {history.isError && (
        <div className="management-inline-error" role="alert">
          观看进度暂未加载，最近观看排序可能不完整。
          <button className="text-link" onClick={() => void history.refetch()}>
            重试进度
          </button>
        </div>
      )}
      {operationError && (
        <div className="management-inline-error" role="alert">
          {operationError}
          <button className="text-link" onClick={() => setOperationError('')}>
            收起
          </button>
        </div>
      )}
      {!!library.data?.length && (
        <div className="management-selection-bar">
          <span className="muted">{items.length} 部符合条件</span>
          <button
            className="text-link"
            disabled={!!busy}
            onClick={() => {
              setSelecting((value) => !value);
              setSelection(new Set());
              setBatchResult('');
            }}
          >
            {selecting ? '结束批量管理' : '批量调整状态'}
          </button>
        </div>
      )}
      {selecting && (
        <div className="management-batch">
          <span>
            已选 {selection.size} / {LIBRARY_BATCH_LIMIT} 部
          </span>
          <button
            className="text-link"
            disabled={!!busy}
            onClick={() =>
              setSelection(new Set(visible.slice(0, LIBRARY_BATCH_LIMIT).map((entry) => entry.id)))
            }
          >
            选择本页
          </button>
          <button
            className="text-link"
            disabled={!!busy || !selection.size}
            onClick={() => setSelection(new Set())}
          >
            取消选择
          </button>
          <label className="management-field compact">
            <span>调整为</span>
            <select
              value={batchStatus}
              disabled={!!busy}
              onChange={(event) => setBatchStatus(event.target.value as WatchStatus)}
            >
              {Object.entries(statusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button secondary small"
            disabled={!!busy || !selection.size}
            onClick={() => void batchUpdate()}
          >
            <Check size={15} aria-hidden="true" />
            {busy === 'batch' ? '正在保存' : '应用状态'}
          </button>
          <small>仅改变追番状态，不改变剧集观看进度。</small>
        </div>
      )}
      {batchResult && <p role="status">{batchResult}</p>}
      {library.isPending ? (
        <Loading />
      ) : library.isError ? (
        <ErrorState error={library.error} retry={() => void library.refetch()} />
      ) : !library.data.length ? (
        <Empty
          title="给喜欢的番剧留个位置"
          action={
            <Link className="button primary" to="/search">
              <Search size={17} aria-hidden="true" />
              去找一部番剧
            </Link>
          }
        >
          在番剧详情页点击“追番”，下次就能在这里找到。
        </Empty>
      ) : !items.length ? (
        <Empty
          title="当前条件下没有番剧"
          action={
            <button
              className="button secondary"
              onClick={() => updateParams({ q: '', status: '', updates: '' })}
            >
              清除筛选
            </button>
          }
        >
          资料库中还有 {library.data.length} 部番剧，可以更换关键词或筛选条件。
        </Empty>
      ) : (
        <>
          <div className={listView ? 'management-library-list' : 'poster-grid management-library-grid'}>
            {visible.map((entry) => (
              <div
                key={entry.id}
                className={`management-library-entry ${selection.has(entry.id) ? 'is-selected' : ''}`}
              >
                {selecting && (
                  <label className="management-entry-selector">
                    <input
                      type="checkbox"
                      checked={selection.has(entry.id)}
                      disabled={!!busy || (!selection.has(entry.id) && selection.size >= LIBRARY_BATCH_LIMIT)}
                      onChange={() => toggle(entry.id)}
                    />
                    <span>选择 {entry.card.title}</span>
                  </label>
                )}
                {listView ? (
                  <article className="management-library-row">
                    <Link
                      to={detailPath(entry.card.sourceId, entry.card.id)}
                      state={{ returnTo: location.pathname + location.search }}
                      aria-label={`查看 ${entry.card.title}`}
                    >
                      <Cover card={entry.card} />
                    </Link>
                    <div className="management-library-copy">
                      <Link
                        className="tile-title"
                        to={detailPath(entry.card.sourceId, entry.card.id)}
                        state={{ returnTo: location.pathname + location.search }}
                      >
                        {entry.card.title}
                      </Link>
                      <p className="muted">
                        {[
                          entry.card.year,
                          sourceNames.get(entry.card.sourceId) ?? entry.card.sourceId,
                          entry.card.remarks,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {toolsFor(entry)}
                    </div>
                  </article>
                ) : (
                  <AnimeTile
                    card={entry.card}
                    sourceName={sourceNames.get(entry.card.sourceId)}
                    action={toolsFor(entry)}
                  />
                )}
              </div>
            ))}
          </div>
          {pageCount > 1 && (
            <nav className="management-pagination" aria-label="资料库分页">
              <button
                className="button secondary small"
                disabled={page <= 1}
                onClick={() => updateParams({ page: String(page - 1) })}
              >
                上一页
              </button>
              <span>
                第 {page} / {pageCount} 页
              </span>
              <button
                className="button secondary small"
                disabled={page >= pageCount}
                onClick={() => updateParams({ page: String(page + 1) })}
              >
                下一页
              </button>
            </nav>
          )}
        </>
      )}
    </>
  );
}
