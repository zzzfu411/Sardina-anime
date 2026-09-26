import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownWideNarrow, ArrowUpWideNarrow, LocateFixed, Search } from 'lucide-react';
import { completedEpisode } from '../../../packages/core/src/progress';
import type { Episode, HistoryEntry, PlayLine } from '../../../packages/core/src/types';
import {
  EPISODE_GROUP_SIZE,
  episodeGroup,
  episodeProgressLabel,
  episodeProgressMap,
  filterEpisodes,
  orderedEpisodes,
  type EpisodeKindFilter,
} from './episode-list';
import './episode-browser.css';

export interface EpisodeBrowserProps {
  line: PlayLine;
  history?: HistoryEntry[];
  currentEpisodeId?: string;
  onSelect?: (episode: Episode) => void;
  episodeHref?: (episode: Episode) => string;
  compact?: boolean;
  sourceActions?: ReactNode;
  onSetCompleted?: (episode: Episode, completed: boolean) => Promise<void>;
}
const noHistory: HistoryEntry[] = [];
const kindLabels: Record<EpisodeKindFilter, string> = {
  all: '全部剧集',
  episode: '正片',
  special: '特别篇',
  movie: '剧场版',
};

export function EpisodeBrowser({
  line,
  history = noHistory,
  currentEpisodeId,
  onSelect,
  episodeHref,
  compact = false,
  sourceActions,
  onSetCompleted,
}: EpisodeBrowserProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<EpisodeKindFilter>('all');
  const [descending, setDescending] = useState(false);
  const ordered = useMemo(() => orderedEpisodes(line.episodes, descending), [line.episodes, descending]);
  const [group, setGroup] = useState(() => episodeGroup(ordered, currentEpisodeId));
  const filtered = useMemo(() => filterEpisodes(ordered, query, kind), [ordered, query, kind]);
  const progress = useMemo(() => episodeProgressMap(line, history), [line, history]);
  const groupCount = Math.max(1, Math.ceil(filtered.length / EPISODE_GROUP_SIZE));
  const visibleGroup = Math.min(group, groupCount - 1);
  const start = visibleGroup * EPISODE_GROUP_SIZE;
  const visible = filtered.slice(start, start + EPISODE_GROUP_SIZE);
  const current = line.episodes.find((episode) => episode.id === currentEpisodeId);
  const list = useRef<HTMLDivElement>(null);
  const currentButton = useRef<HTMLElement>(null);
  const [locateEpoch, setLocateEpoch] = useState(0);
  const [changingCompletion, setChangingCompletion] = useState(false);
  const [completionError, setCompletionError] = useState('');
  const lineKey = JSON.stringify([
    line.episodes[0]?.locator.sourceId,
    line.episodes[0]?.locator.animeId,
    line.id,
  ]);

  useEffect(() => {
    setQuery('');
    setKind('all');
    setGroup(episodeGroup(ordered, currentEpisodeId));
    setCompletionError('');
  }, [lineKey, currentEpisodeId]);

  useLayoutEffect(() => {
    const container = list.current;
    const selected = currentButton.current;
    if (container && selected) {
      const offset = selected.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTop += offset - (container.clientHeight - selected.clientHeight) / 2;
    } else if (container) container.scrollTop = 0;
  }, [lineKey, currentEpisodeId, visibleGroup, query, kind, descending, locateEpoch]);

  const locate = () => {
    setQuery('');
    setKind('all');
    setGroup(episodeGroup(ordered, currentEpisodeId));
    setLocateEpoch((value) => value + 1);
  };
  const updateCompletion = async () => {
    if (!current || !onSetCompleted) return;
    setChangingCompletion(true);
    setCompletionError('');
    try {
      await onSetCompleted(current, !completedEpisodeOrFalse(progress.get(current.id)));
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : '标记失败，请重试');
    } finally {
      setChangingCompletion(false);
    }
  };

  return (
    <div className={`episode-browser${compact ? ' compact' : ''}`}>
      {sourceActions && <div className="episode-source-actions">{sourceActions}</div>}
      <div className="episode-browse-tools">
        <label className="episode-search" htmlFor={`${id}-search`}>
          <Search size={15} aria-hidden="true" />
          <span className="episode-visually-hidden">按集数或标题找剧集</span>
          <input
            id={`${id}-search`}
            type="search"
            value={query}
            placeholder="集数或标题，如 12.5"
            onChange={(event) => {
              setQuery(event.target.value);
              setGroup(0);
            }}
          />
        </label>
        <div className="episode-browse-options">
          <select
            aria-label="剧集类型"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as EpisodeKindFilter);
              setGroup(0);
            }}
          >
            {Object.entries(kindLabels)
              .filter(([value]) => value === 'all' || line.episodes.some((episode) => episode.kind === value))
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
          <button
            type="button"
            aria-label={descending ? '改为剧集正序' : '改为剧集倒序'}
            aria-pressed={descending}
            onClick={() => {
              setDescending(!descending);
              setGroup(
                episodeGroup(
                  filterEpisodes(orderedEpisodes(line.episodes, !descending), query, kind),
                  currentEpisodeId,
                ),
              );
            }}
          >
            {descending ? (
              <ArrowUpWideNarrow size={16} aria-hidden="true" />
            ) : (
              <ArrowDownWideNarrow size={16} aria-hidden="true" />
            )}
            {descending ? '倒序' : '正序'}
          </button>
          {current && (
            <button type="button" onClick={locate}>
              <LocateFixed size={15} aria-hidden="true" />
              定位当前集
            </button>
          )}
        </div>
      </div>
      <div className="episode-range-row">
        <span role="status">
          {filtered.length
            ? `${start + 1}–${Math.min(start + EPISODE_GROUP_SIZE, filtered.length)} / ${filtered.length} 项`
            : '没有符合条件的剧集'}
        </span>
        {groupCount > 1 && (
          <select
            aria-label="剧集区间"
            value={visibleGroup}
            onChange={(event) => setGroup(Number(event.target.value))}
          >
            {Array.from({ length: groupCount }, (_, index) => (
              <option key={index} value={index}>
                第 {index * EPISODE_GROUP_SIZE + 1}–
                {Math.min((index + 1) * EPISODE_GROUP_SIZE, filtered.length)} 项
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="episode-browser-grid" ref={list} aria-label={`${line.name}剧集`}>
        {visible.map((episode) => {
          const active = currentEpisodeId === episode.id;
          const saved = progress.get(episode.id);
          const label = episodeProgressLabel(saved);
          const props = {
            className: `${compact ? 'watch-episode' : 'episode'} episode-choice${active ? ' active' : ''}${saved && completedEpisode(saved) ? ' completed' : ''}`,
            'aria-current': active ? ('step' as const) : undefined,
            'aria-label': `${episode.label} · ${active ? '当前集 · ' : ''}${label}`,
            ref: active
              ? (element: HTMLElement | null) => {
                  currentButton.current = element;
                }
              : undefined,
          };
          const content = (
            <>
              <span>{episode.label}</span>
              <small>{active ? `当前 · ${label}` : label}</small>
            </>
          );
          return episodeHref ? (
            <Link key={episode.id} to={episodeHref(episode)} {...props}>
              {content}
            </Link>
          ) : (
            <button
              type="button"
              key={episode.id}
              {...props}
              disabled={!onSelect}
              onClick={() => onSelect?.(episode)}
            >
              {content}
            </button>
          );
        })}
      </div>
      {current && onSetCompleted && (
        <div className="episode-completion-action">
          <span>
            {current.label} · {episodeProgressLabel(progress.get(current.id))}
          </span>
          <button
            type="button"
            className="text-link"
            disabled={changingCompletion}
            onClick={() => void updateCompletion()}
          >
            {changingCompletion
              ? '正在保存…'
              : completedEpisodeOrFalse(progress.get(current.id))
                ? '标记为未看'
                : '标记为已看完'}
          </button>
          {completionError && <p role="alert">{completionError}</p>}
        </div>
      )}
    </div>
  );
}

function completedEpisodeOrFalse(entry?: HistoryEntry) {
  return entry ? completedEpisode(entry) : false;
}
