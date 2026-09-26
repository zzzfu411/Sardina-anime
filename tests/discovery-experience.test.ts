import { expect, it } from 'vitest';
import {
  EPISODE_GROUP_SIZE,
  episodeGroup,
  episodeProgressMap,
  filterEpisodes,
  orderedEpisodes,
} from '../apps/web/src/episode-list';
import { SearchMemory, completedSearchSnapshot } from '../apps/web/src/search-memory-store';
import { selectModuleSource } from '../apps/web/src/module-source';
import { personalSchedule } from '../apps/web/src/personal-schedule';
import {
  episodeKey,
  type Episode,
  type HistoryEntry,
  type LibraryEntry,
  type SourceState,
} from '../packages/core/src/types';
import { card, episode } from './helpers';

const history = (
  item: Episode,
  position: number,
  at = 1,
  sourceId = item.locator.sourceId,
): HistoryEntry => ({
  key: episodeKey(item.locator),
  card: { ...card, sourceId },
  episode: item,
  position,
  duration: 100,
  capturedAt: new Date(at).toISOString(),
  updatedAt: new Date(at).toISOString(),
});
const storage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

it('locates long-series episodes in bounded windows and preserves fractional and named specials', () => {
  const episodes = Array.from({ length: 1205 }, (_, index) => episode(index + 1));
  const special: Episode = { ...episode(12.5), kind: 'special', label: '第 12.5 话 幕间' };
  const named: Episode = { ...episode(0), id: 'sp', number: null, kind: 'special', label: '海边的假日' };
  const ordered = orderedEpisodes([...episodes].reverse().concat(special, named));
  expect(ordered[0].number).toBe(1);
  expect(episodeGroup(ordered, '180')).toBe(1);
  expect(episodeGroup(ordered, '1205')).toBe(12);
  expect(
    ordered.slice(
      episodeGroup(ordered, '180') * EPISODE_GROUP_SIZE,
      (episodeGroup(ordered, '180') + 1) * EPISODE_GROUP_SIZE,
    ),
  ).toHaveLength(100);
  expect(filterEpisodes(ordered, '１２.５', 'all')).toEqual([special]);
  expect(filterEpisodes(ordered, '第 12 话', 'episode').map((item) => item.number)).toEqual([12]);
  expect(filterEpisodes(ordered, '海边', 'special')).toEqual([named]);
  expect(filterEpisodes(ordered, '12.5', 'episode')).toEqual([]);
  expect(orderedEpisodes([episode(1), episode(2), episode(12.5)], true).map((item) => item.number)).toEqual([
    12.5, 2, 1,
  ]);
});

it('maps progress only when the source locator or episode kind/number is unambiguous', () => {
  const first = episode(1);
  const ambiguous = {
    ...episode(2),
    id: '2-extra',
    locator: { ...episode(2).locator, episodeId: '2-extra' },
  };
  const special = {
    ...episode(1),
    id: 'sp-1',
    kind: 'special' as const,
    locator: { ...episode(1).locator, episodeId: 'sp-1' },
  };
  const line = { id: 'mp4', name: '测试', episodes: [first, episode(2), ambiguous, special] };
  const mapped = episodeProgressMap(line, [
    history(episode(1), 80, 1),
    history(episode(1, 'hls', 'other'), 5, 2),
    history(episode(2, 'hls', 'other'), 70, 3),
    history({ ...episode(1, 'hls', 'other'), kind: 'special' }, 20, 4),
  ]);
  expect(mapped.get('1')?.position).toBe(5);
  expect(mapped.has('2')).toBe(false);
  expect(mapped.has('2-extra')).toBe(false);
  expect(mapped.get('sp-1')?.position).toBe(20);
  expect(episodeProgressMap(line, [history(ambiguous, 40)]).get('2-extra')?.position).toBe(40);
});

it('preserves loaded search pages, cursor, and per-filter scroll state across remounts and reloads', () => {
  const disk = storage();
  const cache = new SearchMemory(disk);
  const results = {
    fixture: {
      status: 'done' as const,
      page: {
        items: [card, { ...card, id: 'second' }, { ...card, id: 'third' }],
        page: 3,
        hasMore: true,
        nextCursor: 'next-4',
      },
    },
  };
  cache.set('fixture', '星空', results, '?q=星空', 1860);
  cache.set('fixture', '星空', results, '?q=星空&view=list', 430);
  const restored = new SearchMemory(disk).get('fixture', '星空');
  expect(restored?.results.fixture.page).toEqual(results.fixture.page);
  expect(restored?.positions).toEqual({ '?q=星空': 1860, '?q=星空&view=list': 430 });
  expect(cache.get('other', '星空')).toBeUndefined();
  expect(cache.get('fixture', '星空剧场版')).toBeUndefined();
});

it('does not resurrect an expired verification challenge or lose already loaded results', () => {
  const pending = {
    fixture: {
      status: 'challenge' as const,
      challenge: { id: 'released' },
      page: { items: [card], page: 2, hasMore: true, nextCursor: 'page3' },
      requestedPage: 3,
      requestedCursor: 'page3',
    },
  };
  const snapshot = completedSearchSnapshot(pending);
  expect(snapshot.fixture.status).toBe('cancelled');
  expect(snapshot.fixture).not.toHaveProperty('challenge');
  expect(snapshot.fixture.requestedCursor).toBe('page3');
  expect(snapshot.fixture.page?.page).toBe(2);
  expect(completedSearchSnapshot({ fixture: { status: 'challenge' } })).toEqual({});
});

it('bounds old search snapshots, expires stale results, and retains in-memory navigation after storage failure', () => {
  let now = 100;
  const cache = new SearchMemory(
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    },
    () => now,
  );
  const results = { fixture: { status: 'done' as const, page: { items: [card], page: 1, hasMore: false } } };
  for (let index = 0; index < 12; index++) cache.set('fixture', String(index), results, '', index);
  expect(cache.get('fixture', '0')).toBeUndefined();
  expect(cache.get('fixture', '11')?.results.fixture.page?.items).toEqual([card]);
  cache.clear('fixture', '11');
  expect(cache.get('fixture', '11')).toBeUndefined();
  now += 31 * 60_000;
  expect(cache.get('fixture', '10')).toBeUndefined();
});

it('honors explicit source choice, remembered independent defaults, and avoiding the old playback source', () => {
  const sources = ['a', 'b', 'c'].map((id) => ({ id }) as SourceState);
  expect(selectModuleSource(sources, 'a', 'b')?.id).toBe('a');
  expect(selectModuleSource(sources, undefined, 'b')?.id).toBe('b');
  expect(selectModuleSource(sources, 'disabled', 'b')).toBeUndefined();
  expect(selectModuleSource(sources, undefined, 'b', 'b')?.id).toBe('a');
  expect(selectModuleSource([sources[1]], undefined, 'b', 'b')?.id).toBe('b');
  expect(selectModuleSource(sources, undefined, 'disabled')?.id).toBe('a');
});

it('connects a personal schedule only through confirmed refs and finds the latest linked-source progress', () => {
  const entry: LibraryEntry = {
    id: 'my-series',
    card,
    refs: [
      { sourceId: 'fixture', id: 'one' },
      { sourceId: 'other', id: 'one' },
    ],
    status: 'watching',
    latestCount: 2,
    seenCount: 1,
    addedAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  };
  const personal = personalSchedule(
    [entry],
    [history(episode(1), 20, 1), history(episode(2, 'hls', 'other'), 10, 2)],
  );
  expect(personal(card).progress?.episode.number).toBe(2);
  expect(personal({ sourceId: 'other', id: 'one' }).entry).toBe(entry);
  expect(personal({ ...card, id: 'same-title-other-edition' }).entry).toBeUndefined();
});
