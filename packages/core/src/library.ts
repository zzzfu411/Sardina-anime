import { normalizeTitle } from './matching';
import {
  refKey,
  type LibraryEntry,
  type LibraryEpisode,
  type SourceDetail,
  type SourceEpisodeSnapshot,
} from './types';

export function pendingUpdateCount(entry: LibraryEntry): number {
  return entry.updates === undefined
    ? Math.max(0, entry.latestCount - entry.seenCount)
    : entry.updates.length + (entry.unidentifiedUpdateCount ?? 0);
}

/** Compare known editions only. Source differences stay visible; line duplicates do not count twice. */
export function episodeSnapshot(detail: SourceDetail, checkedAt: string): SourceEpisodeSnapshot {
  const unique = new Map<string, LibraryEpisode>();
  for (const line of detail.lines) {
    const identities = line.episodes.map((episode) =>
      JSON.stringify([
        episode.kind,
        episode.number === null ? ['label', normalizeTitle(episode.label)] : ['number', episode.number],
      ]),
    );
    const counts = new Map<string, number>();
    for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
    line.episodes.forEach((episode, index) => {
      const identity = identities[index];
      const key = JSON.stringify([
        detail.sourceId,
        detail.id,
        identity,
        ...(counts.get(identity)! > 1 ? [line.id, episode.id] : []),
      ]);
      if (!unique.has(key))
        unique.set(key, {
          key,
          sourceId: detail.sourceId,
          id: detail.id,
          label: episode.label,
          number: episode.number,
          kind: episode.kind,
          locator: episode.locator,
        });
    });
  }
  return { sourceId: detail.sourceId, id: detail.id, checkedAt, episodes: [...unique.values()] };
}

export function withEpisodeSnapshots(entry: LibraryEntry, snapshots: SourceEpisodeSnapshot[]): LibraryEntry {
  const replaced = new Set(snapshots.map(refKey));
  const previous = entry.episodeSnapshots ?? [];
  const nextSnapshots = [...previous.filter((snapshot) => !replaced.has(refKey(snapshot))), ...snapshots];
  const now = snapshots[0]?.checkedAt ?? new Date().toISOString();
  const additions = snapshots.flatMap((snapshot) => {
    const before = previous.find((old) => refKey(old) === refKey(snapshot));
    if (!before) return [];
    const known = new Set(before.episodes.map((episode) => episode.key));
    return snapshot.episodes
      .filter((episode) => !known.has(episode.key))
      .map((episode) => ({ ...episode, addedAt: now }));
  });
  const currentKeys = new Set(
    nextSnapshots.flatMap((snapshot) => snapshot.episodes.map((episode) => episode.key)),
  );
  const pending = new Map(
    (entry.updates ?? [])
      .filter((episode) => currentKeys.has(episode.key))
      .map((episode) => [episode.key, episode]),
  );
  for (const episode of additions) pending.set(episode.key, episode);
  const latestCount = Math.max(
    entry.latestCount,
    0,
    ...nextSnapshots.map((snapshot) => snapshot.episodes.length),
  );
  // Old count-only reminders remain intelligible and can still be explicitly acknowledged.
  const unidentifiedUpdateCount =
    entry.unidentifiedUpdateCount ??
    (entry.updates === undefined ? Math.max(0, entry.latestCount - entry.seenCount) : 0);
  const updates = [...pending.values()];
  return {
    ...entry,
    episodeSnapshots: nextSnapshots,
    updates,
    unidentifiedUpdateCount,
    latestCount,
    seenCount: Math.max(0, latestCount - updates.length - unidentifiedUpdateCount),
    checkedAt: now,
    contentUpdatedAt: additions.length ? now : entry.contentUpdatedAt,
  };
}
