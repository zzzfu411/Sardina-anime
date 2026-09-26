import { describe, expect, it } from 'vitest';
import {
  episodeNumber,
  groupAnime,
  inferSeason,
  matchingEpisode,
  sameAnime,
} from '../packages/core/src/matching';
import { card, episode } from './helpers';

describe('edition and episode identity', () => {
  it('requires known edition metadata for automatic title matching', () => {
    expect(sameAnime(card, { ...card, sourceId: 'two' })).toBe(true);
    for (const patch of [
      { year: undefined },
      { season: undefined },
      { kind: 'unknown' as const },
      { year: 2025 },
      { season: 2 },
      { kind: 'movie' as const },
    ]) {
      expect(sameAnime(card, { ...card, sourceId: 'two', ...patch })).toBe(false);
    }
    expect(
      groupAnime([card, card, { ...card, sourceId: 'two' }, { ...card, sourceId: 'third', year: 2025 }]),
    ).toHaveLength(2);
  });
  it('permits common external IDs but still rejects known conflicts', () => {
    const a = { ...card, kind: 'unknown' as const, season: undefined, externalIds: { bangumi: '123' } };
    expect(sameAnime(a, { ...a, sourceId: 'b', title: '別名' })).toBe(true);
    expect(sameAnime(a, { ...a, sourceId: 'b', year: 2025 })).toBe(false);
  });
  it.each([
    ['第十二话', 12],
    ['第 12.5 集 总集篇', 12.5],
    ['EP 03', 3],
    ['第二十一集', 21],
    ['第〇六话', 6],
    ['SP', null],
    ['剧场版', null],
    ['2026年预告', null],
    ['第百零二话', 102],
  ])('reads %s conservatively', (label, value) => expect(episodeNumber(label)).toBe(value));
  it('does not match ambiguous duplicate episode numbers or specials to regular episodes', () => {
    expect(matchingEpisode(episode(), [episode(), episode(1, 'other')])).toBeUndefined();
    expect(matchingEpisode(episode(), [{ ...episode(), kind: 'special' }])).toBeUndefined();
    expect(matchingEpisode(episode(12.5), [episode(12), episode(12.5)])?.number).toBe(12.5);
    expect(inferSeason('葬送的芙莉莲')).toBeUndefined();
    expect(inferSeason('测试 第二季')).toBe(2);
  });
});
