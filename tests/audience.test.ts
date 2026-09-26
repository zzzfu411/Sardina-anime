import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AudienceSnapshot } from '../packages/core/src/types';
import { AudienceLeases, type AudienceLeaseOptions } from '../packages/engine/src/audience';

const managers: AudienceLeases[] = [];
const snapshot: AudienceSnapshot = {
  count: 17,
  scope: 'episode-line',
  sampledAt: '2026-09-26T12:00:00.000Z',
};

function manager(options: AudienceLeaseOptions = {}) {
  const leases = new AudienceLeases(options);
  managers.push(leases);
  return leases;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(snapshot.sampledAt));
});

afterEach(async () => {
  const shuttingDown = managers.splice(0).map((leases) => leases.shutdown());
  await vi.runAllTimersAsync();
  await Promise.all(shuttingDown);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('shares one concurrent registration and retains the same snapshot for local heartbeats', async () => {
  const leases = manager(),
    ack = deferred<AudienceSnapshot>();
  const join = vi.fn(() => ack.promise),
    leave = vi.fn(async () => {});
  const first = leases.open('session:1', join, leave);
  const second = leases.open('session:1', join, leave);
  expect(second).toBe(first);
  await Promise.resolve();
  expect(join).toHaveBeenCalledOnce();
  ack.resolve(snapshot);
  expect(await first).toBe(snapshot);
  expect(await second).toBe(snapshot);

  await vi.advanceTimersByTimeAsync(60_000);
  const replacementJoin = vi.fn(async () => ({ ...snapshot, count: 999 }));
  expect(await leases.open('session:1', replacementJoin, vi.fn())).toBe(snapshot);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(leave).not.toHaveBeenCalled();
  expect(replacementJoin).not.toHaveBeenCalled();
  expect(join).toHaveBeenCalledOnce();
  await leases.close('session:1');
  expect(leave).toHaveBeenCalledOnce();
});

it('waits for an in-flight acknowledgement before closing, without reviving the lease', async () => {
  const leases = manager(),
    ack = deferred<AudienceSnapshot>(),
    left = deferred<void>();
  const events: string[] = [];
  const join = vi.fn(() => {
    events.push('open');
    return ack.promise;
  });
  const leave = vi.fn(() => {
    events.push('close');
    return left.promise;
  });
  const opening = leases.open('session:1', join, leave);
  const rejectedOpening = expect(opening).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  const closing = leases.close('session:1');
  expect(leases.close('session:1')).toBe(closing);
  await Promise.resolve();
  expect(events).toEqual(['open']);
  await expect(leases.open('session:1', join, leave)).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  ack.resolve(snapshot);
  await rejectedOpening;
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(['open', 'close']);
  left.resolve();
  await closing;
  await leases.close('session:1');
  await leases.shutdown();
  expect(join).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();
});

it('remembers a close that arrives before the open request', async () => {
  const leases = manager(),
    join = vi.fn(async () => snapshot),
    leave = vi.fn(async () => {});
  await leases.close('delayed:1');
  await expect(leases.open('delayed:1', join, leave)).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  expect(join).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
});

it('rejects replay after a completed close but allows a new playback generation', async () => {
  const leases = manager(),
    join = vi.fn(async () => snapshot),
    leave = vi.fn(async () => {});
  await leases.open('session:1', join, leave);
  await leases.close('session:1');
  await expect(leases.open('session:1', join, leave)).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  expect(await leases.open('session:2', join, leave)).toBe(snapshot);
  expect(join).toHaveBeenCalledTimes(2);
  expect(leave).toHaveBeenCalledOnce();
});

it('reclaims a lease after 90 seconds without a heartbeat and closes it only once', async () => {
  const leases = manager(),
    join = vi.fn(async () => snapshot),
    leave = vi.fn(async () => {});
  await leases.open('session:1', join, leave);
  await vi.advanceTimersByTimeAsync(89_999);
  expect(leave).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(leave).toHaveBeenCalledOnce();
  await expect(leases.open('session:1', join, leave)).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  await vi.advanceTimersByTimeAsync(90_000);
  await leases.close('session:1');
  expect(leave).toHaveBeenCalledOnce();
});

it('does not let a late heartbeat revive an expired lease between sweeps', async () => {
  let now = 0;
  const leases = manager({ ttlMs: 100, sweepMs: 1_000, now: () => now });
  const join = vi.fn(async () => snapshot),
    leave = vi.fn(async () => {});
  await leases.open('session:1', join, leave);
  now = 101;
  await expect(leases.open('session:1', join, leave)).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  await leases.close('session:1');
  expect(join).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();
});

it('shutdown blocks new opens immediately and drains both active and pending joins', async () => {
  const leases = manager(),
    ack = deferred<AudienceSnapshot>();
  const activeLeave = vi.fn(async () => {}),
    pendingLeave = vi.fn(async () => {});
  await leases.open('ready:1', async () => snapshot, activeLeave);
  const opening = leases.open('pending:1', () => ack.promise, pendingLeave);
  const rejectedOpening = expect(opening).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  const stopping = leases.shutdown();
  expect(leases.shutdown()).toBe(stopping);
  const lateJoin = vi.fn(async () => snapshot);
  await expect(leases.open('new:1', lateJoin, vi.fn())).rejects.toHaveProperty('code', 'AUDIENCE_STOPPED');
  await vi.advanceTimersByTimeAsync(0);
  expect(activeLeave).toHaveBeenCalledOnce();
  expect(pendingLeave).not.toHaveBeenCalled();
  ack.resolve(snapshot);
  await rejectedOpening;
  await stopping;
  expect(pendingLeave).toHaveBeenCalledOnce();
  expect(lateJoin).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not retry or synthesize a count after a failed registration and pairs its uncertain result', async () => {
  const leases = manager(),
    failure = new Error('upstream connection reset');
  const join = vi.fn(async () => {
      throw failure;
    }),
    leave = vi.fn(async () => {});
  await expect(leases.open('failed:1', join, leave)).rejects.toBe(failure);
  await leases.close('failed:1');
  await expect(leases.open('failed:1', join, leave)).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  await vi.advanceTimersByTimeAsync(180_000);
  expect(join).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();
});

it('also cleans up when the registration callback throws synchronously', async () => {
  const leases = manager(),
    leave = vi.fn(async () => {});
  const failure = new Error('synchronous provider failure');
  await expect(
    leases.open(
      'failed:1',
      () => {
        throw failure;
      },
      leave,
    ),
  ).rejects.toBe(failure);
  await leases.close('failed:1');
  expect(leave).toHaveBeenCalledOnce();
});

it('times out a hanging registration at 8 seconds and observes its later rejection', async () => {
  const leases = manager(),
    ack = deferred<AudienceSnapshot>(),
    leave = vi.fn(async () => {});
  const opening = leases.open('timed:1', () => ack.promise, leave);
  const rejectedOpening = expect(opening).rejects.toHaveProperty('code', 'AUDIENCE_TIMEOUT');
  await vi.advanceTimersByTimeAsync(7_999);
  expect(leave).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejectedOpening;
  await leases.close('timed:1');
  expect(leave).toHaveBeenCalledOnce();
  ack.reject(new Error('late socket failure'));
  await vi.advanceTimersByTimeAsync(0);
  await expect(leases.open('timed:1', async () => snapshot, leave)).rejects.toHaveProperty(
    'code',
    'AUDIENCE_CLOSED',
  );
  expect(leave).toHaveBeenCalledOnce();
});

it('does not revive or close twice when a timed-out registration eventually succeeds', async () => {
  const leases = manager(),
    ack = deferred<AudienceSnapshot>(),
    leave = vi.fn(async () => {});
  const opening = leases.open('timed:1', () => ack.promise, leave);
  const rejectedOpening = expect(opening).rejects.toHaveProperty('code', 'AUDIENCE_TIMEOUT');
  await vi.advanceTimersByTimeAsync(8_000);
  await rejectedOpening;
  await leases.close('timed:1');
  ack.resolve(snapshot);
  await vi.advanceTimersByTimeAsync(0);
  await leases.shutdown();
  expect(leave).toHaveBeenCalledOnce();
  await expect(leases.open('new:1', async () => snapshot, leave)).rejects.toHaveProperty(
    'code',
    'AUDIENCE_STOPPED',
  );
});

it('bounds a hanging close by 8 seconds, releases capacity, and never retries it', async () => {
  const leases = manager({ maxActive: 1 }),
    left = deferred<void>();
  const leave = vi.fn(() => left.promise);
  await leases.open('first:1', async () => snapshot, leave);
  const closing = leases.close('first:1');
  const rejectedClose = expect(closing).rejects.toHaveProperty('code', 'AUDIENCE_TIMEOUT');
  await expect(leases.open('second:1', async () => snapshot, vi.fn())).rejects.toHaveProperty(
    'code',
    'AUDIENCE_LIMIT',
  );
  await vi.advanceTimersByTimeAsync(8_000);
  await rejectedClose;
  expect(
    await leases.open(
      'second:1',
      async () => snapshot,
      async () => {},
    ),
  ).toBe(snapshot);
  left.reject(new Error('late close failure'));
  await vi.advanceTimersByTimeAsync(0);
  await leases.close('first:1');
  expect(leave).toHaveBeenCalledOnce();
});

it('reports an explicit close failure while shutdown still cleans up every other lease', async () => {
  const leases = manager(),
    failure = new Error('close unavailable');
  const failedLeave = vi.fn(async () => {
      throw failure;
    }),
    goodLeave = vi.fn(async () => {});
  await leases.open('bad:1', async () => snapshot, failedLeave);
  await leases.open('good:1', async () => snapshot, goodLeave);
  await expect(leases.close('bad:1')).rejects.toBe(failure);
  await leases.shutdown();
  await leases.close('bad:1');
  expect(failedLeave).toHaveBeenCalledOnce();
  expect(goodLeave).toHaveBeenCalledOnce();
});

it('contains failures from automatic expiry cleanup and clears every shutdown timer', async () => {
  const leases = manager(),
    leave = vi.fn(async () => {
      throw new Error('leave failed');
    });
  await leases.open('expired:1', async () => snapshot, leave);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(leave).toHaveBeenCalledOnce();
  await leases.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

it('contains a failed best-effort close after a failed registration without retrying either request', async () => {
  const leases = manager(),
    joinError = new Error('unknown registration outcome');
  const join = vi.fn(async () => {
    throw joinError;
  });
  const leave = vi.fn(async () => {
    throw new Error('close also unavailable');
  });
  await expect(leases.open('failed:1', join, leave)).rejects.toBe(joinError);
  await vi.advanceTimersByTimeAsync(180_000);
  await leases.shutdown();
  expect(join).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('finishes shutdown after bounded join and leave deadlines even when neither upstream settles', async () => {
  const leases = manager(),
    join = vi.fn(() => new Promise<AudienceSnapshot>(() => {}));
  const leave = vi.fn(() => new Promise<void>(() => {}));
  const opening = leases.open('hung:1', join, leave);
  const rejectedOpening = expect(opening).rejects.toHaveProperty('code', 'AUDIENCE_TIMEOUT');
  const stopping = leases.shutdown();
  let finished = false;
  void stopping.then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(7_999);
  expect(leave).not.toHaveBeenCalled();
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejectedOpening;
  expect(leave).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(7_999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await stopping;
  expect(finished).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('limits active registrations to 64 while heartbeats remain allowed at capacity', async () => {
  const leases = manager(),
    join = vi.fn(async () => snapshot),
    leave = vi.fn(async () => {});
  await Promise.all(Array.from({ length: 64 }, (_, index) => leases.open(`session:${index}`, join, leave)));
  await expect(leases.open('overflow:1', join, leave)).rejects.toHaveProperty('code', 'AUDIENCE_LIMIT');
  expect(await leases.open('session:0', join, leave)).toBe(snapshot);
  expect(join).toHaveBeenCalledTimes(64);
  await leases.close('session:0');
  expect(await leases.open('replacement:1', join, leave)).toBe(snapshot);
  await leases.shutdown();
  expect(join).toHaveBeenCalledTimes(65);
  expect(leave).toHaveBeenCalledTimes(65);
});

it('bounds closed tombstones at 256 without forgetting a still-closing active lease', async () => {
  const leases = manager(),
    ack = deferred<AudienceSnapshot>(),
    leave = vi.fn(async () => {});
  const opening = leases.open('pending:1', () => ack.promise, leave);
  const rejectedOpening = expect(opening).rejects.toHaveProperty('code', 'AUDIENCE_CLOSED');
  const closing = leases.close('pending:1');
  for (let index = 0; index < 300; index++) await leases.close(`absent:${index}`);
  const state = leases as unknown as { active: Map<string, unknown>; tombstones: Set<string> };
  expect(state.tombstones.size).toBe(256);
  expect(state.active.size).toBe(1);
  await expect(leases.open('absent:299', async () => snapshot, leave)).rejects.toHaveProperty(
    'code',
    'AUDIENCE_CLOSED',
  );
  await expect(leases.open('pending:1', async () => snapshot, leave)).rejects.toHaveProperty(
    'code',
    'AUDIENCE_CLOSED',
  );
  ack.resolve(snapshot);
  await rejectedOpening;
  await closing;
  expect(state.active.size).toBe(0);
  expect(state.tombstones.size).toBe(256);
  await expect(leases.open('pending:1', async () => snapshot, leave)).rejects.toHaveProperty(
    'code',
    'AUDIENCE_CLOSED',
  );
  expect(leave).toHaveBeenCalledOnce();
});
