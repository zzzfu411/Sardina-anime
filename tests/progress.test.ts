import { describe, expect, it } from 'vitest';
import { continuation, completedEpisode, recentSeries, relatedHistory } from '../packages/core/src/progress';
import { episodeKey, type HistoryEntry, type LibraryEntry } from '../packages/core/src/types';
import { card, detail, episode } from './helpers';
const record = (n: number, position = 9, completed?: boolean): HistoryEntry => ({
  card,
  episode: episode(n),
  key: episodeKey(episode(n).locator),
  position,
  duration: 24,
  capturedAt: `2026-06-01T00:00:${String(n).padStart(2, '0')}.000Z`,
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...(completed !== undefined ? { completed } : {}),
});
describe('shared continuation policy', () => {
  it('keeps the latest completed episode and chooses the next instead of resurrecting an older partial episode', () => {
    const history = [record(2, 24), record(1)];
    expect(recentSeries(history, [])[0].episode.id).toBe('2');
    const target = continuation(detail, history);
    expect(target.kind).toBe('next');
    expect(target.episode?.number).toBe(12.5);
    expect(target.position).toBe(0);
  });
  it('resumes a deliberate rewatch even when its episode number is lower', () => {
    const rewatch = { ...record(1, 6, false), capturedAt: '2026-06-02T00:00:00.000Z' };
    const target = continuation(detail, relatedHistory([record(2, 24), rewatch], [card]));
    expect(target).toMatchObject({ kind: 'resume', position: 6 });
    expect(target.episode?.id).toBe('1');
  });
  it('maps by episode number across lines rather than reusing an unrelated source ID', () => {
    const alternate = {
      ...detail,
      lines: [
        {
          ...detail.lines[0],
          id: 'other',
          episodes: [
            { ...episode(2, 'other'), id: '1' },
            { ...episode(1, 'other'), id: '99' },
          ],
        },
      ],
    };
    expect(continuation(alternate, [record(1)]).episode?.id).toBe('99');
  });
  it('requires a unique episode mapping and preserves explicit completion decisions', () => {
    const ambiguous = {
      ...detail,
      lines: [
        {
          ...detail.lines[0],
          id: 'other',
          episodes: [episode(1, 'other'), { ...episode(1, 'other'), id: 'duplicate' }],
        },
      ],
    };
    expect(continuation(ambiguous, [record(1)]).kind).toBe('choose');
    expect(completedEpisode(record(1, 24, false))).toBe(false);
    expect(completedEpisode(record(1, 9, true))).toBe(true);
  });
  it('groups only explicitly associated references in the home continuation list', () => {
    const other = { ...record(2), card: { ...card, sourceId: 'other' } };
    const library: LibraryEntry[] = [
      {
        id: 'joined',
        refs: [card, other.card],
        card,
        status: 'watching',
        addedAt: record(1).updatedAt,
        updatedAt: record(1).updatedAt,
        latestCount: 0,
        seenCount: 0,
      },
    ];
    expect(recentSeries([record(1), other], library)).toHaveLength(1);
    expect(recentSeries([record(1), other], [])).toHaveLength(2);
  });
});
