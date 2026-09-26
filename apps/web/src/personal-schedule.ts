import { historyTime } from '../../../packages/core/src/progress';
import {
  refKey,
  type HistoryEntry,
  type LibraryEntry,
  type SourceRef,
} from '../../../packages/core/src/types';

/** Personal schedule matches only explicitly linked source refs, never a similar title. */
export function personalSchedule(library: LibraryEntry[], history: HistoryEntry[]) {
  const entries = new Map<string, LibraryEntry>();
  for (const entry of library) for (const ref of entry.refs) entries.set(refKey(ref), entry);
  const recent = new Map<string, HistoryEntry>();
  for (const item of history) {
    const entry = entries.get(refKey(item.card));
    if (!entry) continue;
    const previous = recent.get(entry.id);
    if (!previous || historyTime(previous) < historyTime(item)) recent.set(entry.id, item);
  }
  return (ref: SourceRef) => {
    const entry = entries.get(refKey(ref));
    return { entry, progress: entry ? recent.get(entry.id) : undefined };
  };
}
