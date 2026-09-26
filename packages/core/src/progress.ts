import { matchingEpisode } from './matching';
import {
  episodeKey,
  refKey,
  type Episode,
  type HistoryEntry,
  type LibraryEntry,
  type PlayLine,
  type SourceDetail,
  type SourceRef,
} from './types';

export const historyTime = (entry: HistoryEntry) => Date.parse(entry.capturedAt ?? entry.updatedAt);
export const completedEpisode = (entry: HistoryEntry) =>
  entry.completed ?? (entry.duration > 0 && entry.duration - entry.position <= 0.5);

export function relatedRefs(ref: SourceRef, library: LibraryEntry[]): SourceRef[] {
  return library.find((entry) => entry.refs.some((item) => refKey(item) === refKey(ref)))?.refs ?? [ref];
}
export function relatedHistory(history: HistoryEntry[], refs: SourceRef[]): HistoryEntry[] {
  const keys = new Set(refs.map(refKey));
  return history
    .filter((entry) => keys.has(refKey(entry.card)))
    .sort((a, b) => historyTime(b) - historyTime(a));
}
/** Group before inspecting completion, so a finished latest episode cannot resurrect an older one. */
export function recentSeries(history: HistoryEntry[], library: LibraryEntry[], limit = 6) {
  const groups = new Map<string, string>();
  for (const entry of library) for (const ref of entry.refs) groups.set(refKey(ref), entry.id);
  const seen = new Set<string>();
  return [...history]
    .sort((a, b) => historyTime(b) - historyTime(a))
    .filter((entry) => {
      const key = groups.get(refKey(entry.card)) ?? refKey(entry.card);
      if (seen.has(key)) return false;
      seen.add(key);
      return entry.position >= 1 || completedEpisode(entry);
    })
    .slice(0, limit);
}
export function progressForEpisode(episode: Episode, line: PlayLine, history: HistoryEntry[]) {
  return history.find(
    (entry) =>
      episodeKey(entry.episode.locator) === episodeKey(episode.locator) ||
      matchingEpisode(entry.episode, line.episodes)?.id === episode.id,
  );
}
export interface Continuation {
  line?: PlayLine;
  episode?: Episode;
  position: number;
  kind: 'start' | 'resume' | 'next' | 'replay' | 'choose';
  previous?: HistoryEntry;
}
export function continuation(
  detail: SourceDetail,
  history: HistoryEntry[],
  preferredLine?: string,
): Continuation {
  const previous = [...history].sort((a, b) => historyTime(b) - historyTime(a))[0];
  const line =
    detail.lines.find((item) => item.id === preferredLine) ??
    detail.lines.find(
      (item) => previous?.card.sourceId === detail.sourceId && item.id === previous.episode.locator.lineId,
    ) ??
    detail.lines[0];
  if (!line?.episodes.length) return { line, position: 0, kind: 'choose', previous };
  if (!previous) return { line, episode: line.episodes[0], position: 0, kind: 'start' };
  const exact =
    previous.card.sourceId === detail.sourceId &&
    previous.card.id === detail.id &&
    previous.episode.locator.lineId === line.id
      ? line.episodes.find((item) => item.id === previous.episode.id)
      : undefined;
  const episode = exact ?? matchingEpisode(previous.episode, line.episodes);
  if (!episode) return { line, position: 0, kind: 'choose', previous };
  if (!completedEpisode(previous))
    return { line, episode, position: previous.position, kind: 'resume', previous };
  const next = line.episodes[line.episodes.indexOf(episode) + 1];
  return next
    ? { line, episode: next, position: 0, kind: 'next', previous }
    : { line, episode, position: 0, kind: 'replay', previous };
}

export function continuationLabel(target: Continuation) {
  const label = target.episode?.label ?? '';
  if (target.kind === 'choose') return '选择剧集';
  if (target.kind === 'start') return `开始观看 · ${label}`;
  if (target.kind === 'next') return `观看下一话 · ${label}`;
  if (target.kind === 'replay') return `重看 · ${label}`;
  return `继续观看 · ${label} · ${Math.floor(target.position / 60)}:${String(Math.floor(target.position % 60)).padStart(2, '0')}`;
}
