import { completedEpisode, historyTime } from '../../../packages/core/src/progress';
import { episodeKey, type Episode, type HistoryEntry, type PlayLine } from '../../../packages/core/src/types';

export const EPISODE_GROUP_SIZE = 100;
export type EpisodeKindFilter = 'all' | Episode['kind'];
const kindOrder: Record<Episode['kind'], number> = { episode: 0, special: 1, movie: 2 };
const identity = (episode: Episode) => JSON.stringify([episode.kind, episode.number]);

export function orderedEpisodes(episodes: Episode[], descending = false) {
  const ordered = episodes
    .map((episode, index) => ({ episode, index }))
    .sort(
      (a, b) =>
        kindOrder[a.episode.kind] - kindOrder[b.episode.kind] ||
        (a.episode.number ?? Number.MAX_SAFE_INTEGER) - (b.episode.number ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ episode }) => episode);
  return descending ? ordered.reverse() : ordered;
}

export function filterEpisodes(episodes: Episode[], query: string, kind: EpisodeKindFilter) {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
  const numeric = /^(?:第\s*)?\d+(?:\.\d+)?\s*(?:集|话|話|回)?$/.test(normalized)
    ? Number(normalized.replace(/^第\s*|\s*(?:集|话|話|回)$/g, ''))
    : undefined;
  return episodes.filter(
    (episode) =>
      (kind === 'all' || episode.kind === kind) &&
      (!normalized ||
        (numeric !== undefined
          ? episode.number === numeric
          : episode.label.normalize('NFKC').toLocaleLowerCase().includes(normalized))),
  );
}

export function episodeGroup(episodes: Episode[], episodeId: string | undefined) {
  return Math.floor(
    Math.max(
      0,
      episodes.findIndex((episode) => episode.id === episodeId),
    ) / EPISODE_GROUP_SIZE,
  );
}

/** Only unambiguous episode numbers share progress between confirmed versions/lines. */
export function episodeProgressMap(line: PlayLine, history: HistoryEntry[]) {
  const exact = new Map(line.episodes.map((episode) => [episodeKey(episode.locator), episode]));
  const identities = new Map<string, Episode | null>();
  for (const episode of line.episodes) {
    if (episode.number === null) continue;
    const key = identity(episode);
    identities.set(key, identities.has(key) ? null : episode);
  }
  const result = new Map<string, HistoryEntry>();
  for (const entry of [...history].sort((a, b) => historyTime(b) - historyTime(a))) {
    const episode =
      exact.get(episodeKey(entry.episode.locator)) ??
      (entry.episode.number === null ? undefined : identities.get(identity(entry.episode)));
    if (episode && !result.has(episode.id)) result.set(episode.id, entry);
  }
  return result;
}

export function episodeProgressLabel(entry?: HistoryEntry) {
  if (!entry) return '未看';
  if (completedEpisode(entry)) return '已看完';
  if (entry.position <= 0) return '未看';
  return `看到 ${Math.floor(entry.position / 60)}:${String(Math.floor(entry.position % 60)).padStart(2, '0')}`;
}
