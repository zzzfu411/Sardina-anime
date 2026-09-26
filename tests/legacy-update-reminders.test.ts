import { afterEach, describe, expect, it } from 'vitest';
import { episodeSnapshot, pendingUpdateCount, withEpisodeSnapshots } from '../packages/core/src/library';
import { Store } from '../packages/engine/src/store';
import { card, detail, episode } from './helpers';

const stores: Store[] = [];
const open = () => {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
});
const snapshot = (count: number, day = 1) =>
  episodeSnapshot(
    {
      ...detail,
      lines: [
        { ...detail.lines[0], episodes: Array.from({ length: count }, (_, index) => episode(index + 1)) },
      ],
    },
    `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  );

function restoreLegacyEntry() {
  const store = open();
  const original = store.addLibrary(card, 'watching');
  // A v1 export may omit checkedAt; old source merges could still preserve count-only reminders.
  const backup = JSON.parse(
    JSON.stringify({
      ...store.export(),
      library: [{ ...original, latestCount: 5, seenCount: 3 }],
    }),
  );
  expect(Object.hasOwn(backup.library[0], 'checkedAt')).toBe(false);
  expect(Object.hasOwn(backup.library[0], 'updates')).toBe(false);
  store.restore(backup);
  return { store, entry: store.library()[0] };
}

describe('legacy count reminders without a previous check timestamp', () => {
  it('preserves valid restored reminders when the first episode snapshot is established', () => {
    const { entry } = restoreLegacyEntry();
    expect(pendingUpdateCount(entry)).toBe(2);
    const checked = withEpisodeSnapshots(entry, [snapshot(5)]);
    expect(checked.checkedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(checked.updates).toEqual([]);
    expect(checked.unidentifiedUpdateCount).toBe(2);
    expect(pendingUpdateCount(checked)).toBe(2);
  });

  it('does not duplicate old reminders on repeat checks or when a concrete new episode arrives', () => {
    const { entry } = restoreLegacyEntry();
    const baseline = withEpisodeSnapshots(entry, [snapshot(5)]);
    const repeated = withEpisodeSnapshots(baseline, [snapshot(5, 2)]);
    expect(pendingUpdateCount(repeated)).toBe(2);
    const added = withEpisodeSnapshots(repeated, [snapshot(6, 3)]);
    expect(added.updates?.map((item) => item.number)).toEqual([6]);
    expect(added.unidentifiedUpdateCount).toBe(2);
    expect(pendingUpdateCount(added)).toBe(3);
    expect(pendingUpdateCount(withEpisodeSnapshots(added, [snapshot(6, 4)]))).toBe(3);
  });

  it('clears both old and identified reminders only after explicit acknowledgement', () => {
    const { store, entry } = restoreLegacyEntry();
    const baseline = withEpisodeSnapshots(entry, [snapshot(5)]);
    const checked = store.saveLibrary(withEpisodeSnapshots(baseline, [snapshot(6, 2)]));
    expect(pendingUpdateCount(checked)).toBe(3);
    const acknowledged = store.updateLibrary(checked.id, { markSeen: true, revision: checked.revision });
    expect(acknowledged.updates).toEqual([]);
    expect(acknowledged.unidentifiedUpdateCount).toBe(0);
    expect(pendingUpdateCount(withEpisodeSnapshots(acknowledged, [snapshot(6, 3)]))).toBe(0);
    const next = withEpisodeSnapshots(acknowledged, [snapshot(7, 4)]);
    expect(next.updates?.map((item) => item.number)).toEqual([7]);
    expect(pendingUpdateCount(next)).toBe(1);
  });

  it('does not invent old reminders for a new collection with zero counts', () => {
    const store = open();
    const entry = store.addLibrary(card, 'watching');
    expect(entry.checkedAt).toBeUndefined();
    expect(entry.latestCount).toBe(0);
    expect(entry.seenCount).toBe(0);
    const baseline = withEpisodeSnapshots(entry, [snapshot(5)]);
    expect(baseline.unidentifiedUpdateCount).toBe(0);
    expect(pendingUpdateCount(baseline)).toBe(0);
    expect(pendingUpdateCount(withEpisodeSnapshots(baseline, [snapshot(6, 2)]))).toBe(1);
  });
});
