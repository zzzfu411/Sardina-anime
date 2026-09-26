import { describe, expect, it } from 'vitest';
import { filterLibrary, groupHistory, latestForLibrary } from '../apps/web/src/data-management-utils';
import { episodeKey, type HistoryEntry, type LibraryEntry } from '../packages/core/src/types';
import { card, episode } from './helpers';

const libraryEntry = (id: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  card: { ...card, id },
  refs: [{ sourceId: card.sourceId, id }],
  status: 'watching',
  addedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  latestCount: 0,
  seenCount: 0,
  ...extra,
});
const record = (id: string, at: string, sourceId = 'fixture', lineId = 'mp4'): HistoryEntry => {
  const item = {
    ...episode(1, lineId, sourceId),
    locator: { ...episode(1, lineId, sourceId).locator, animeId: id },
  };
  return {
    card: { ...card, id, sourceId },
    episode: item,
    key: episodeKey(item.locator),
    position: 5,
    duration: 24,
    updatedAt: at,
  };
};

describe('library management state', () => {
  it('sorts by the newest sample from explicitly associated sources rather than source membership order', () => {
    const entries = [
      libraryEntry('one', {
        refs: [
          { sourceId: 'fixture', id: 'one' },
          { sourceId: 'other', id: 'alt' },
        ],
      }),
      libraryEntry('two'),
    ];
    const history = [
      record('one', '2026-01-01'),
      record('two', '2026-02-01'),
      record('alt', '2026-03-01', 'other'),
    ];
    const latest = latestForLibrary(history, entries);
    expect(latest.get('one')?.card.sourceId).toBe('other');
    expect(
      filterLibrary(entries, { query: '', status: 'all', updatesOnly: false, sort: 'watched' }, latest).map(
        (item) => item.id,
      ),
    ).toEqual(['one', 'two']);
  });
  it('combines title, status and new-episode filters without confusing an empty filter with an empty library', () => {
    const entries = [
      libraryEntry('one', {
        card: { ...card, title: 'ＡＢＣ 放映室' },
        updates: [],
        unidentifiedUpdateCount: 2,
      }),
      libraryEntry('two', { status: 'completed', latestCount: 5, seenCount: 1 }),
    ];
    expect(
      filterLibrary(
        entries,
        { query: ' abc ', status: 'watching', updatesOnly: true, sort: 'title' },
        new Map(),
      ).map((item) => item.id),
    ).toEqual(['one']);
    expect(
      filterLibrary(
        entries,
        { query: 'abc', status: 'completed', updatesOnly: false, sort: 'title' },
        new Map(),
      ),
    ).toEqual([]);
    expect(entries).toHaveLength(2);
  });
  it('uses actual episode update time independently of status edits and cleared reminders', () => {
    const entries = [
      libraryEntry('one', { contentUpdatedAt: '2026-02-01', updates: [], updatedAt: '2026-09-01' }),
      libraryEntry('two', { contentUpdatedAt: '2026-03-01', updates: [], updatedAt: '2026-03-01' }),
      libraryEntry('new-status', { updatedAt: '2026-10-01' }),
    ];
    expect(
      filterLibrary(
        entries,
        { query: '', status: 'all', updatesOnly: false, sort: 'updated' },
        new Map(),
      ).map((item) => item.id),
    ).toEqual(['two', 'one', 'new-status']);
  });
});

describe('history grouping', () => {
  it('does not join identically titled works without an explicit association', () => {
    const history = [record('one', '2026-01-01'), record('two', '2026-02-01', 'other')];
    expect(groupHistory(history, [])).toHaveLength(2);
  });
  it('joins known sources but preserves every line record and keeps newest progress first', () => {
    const entry = libraryEntry('one', {
      refs: [
        { sourceId: 'fixture', id: 'one' },
        { sourceId: 'other', id: 'alt' },
      ],
    });
    const first = record('one', '2026-01-01');
    const otherLine = record('one', '2026-02-01', 'fixture', 'hls');
    const otherSource = { ...record('alt', '2026-01-01', 'other'), capturedAt: '2026-03-01' };
    const groups = groupHistory([first, otherLine, otherSource, otherLine], [entry]);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((item) => item.key)).toEqual([otherSource.key, otherLine.key, first.key]);
    expect(groups[0].refs).toEqual(entry.refs);
  });
  it('keeps stable source identities when IDs contain delimiters', () => {
    const history = [record('b:c', '2026-01-01', 'a'), record('c', '2026-02-01', 'a:b')];
    // These artificial records intentionally exercise grouping without a library association.
    history[1].key = 'different-record';
    expect(groupHistory(history, [])).toHaveLength(2);
  });
});
