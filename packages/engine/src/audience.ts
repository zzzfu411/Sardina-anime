import type { AudienceSnapshot } from '../../core/src/types';
import { AppError } from './errors';

export interface AudienceLeaseOptions {
  ttlMs?: number;
  sweepMs?: number;
  timeoutMs?: number;
  maxActive?: number;
  maxClosed?: number;
  now?: () => number;
}

interface Lease {
  key: string;
  touchedAt: number;
  joined: Promise<AudienceSnapshot>;
  opened: Promise<AudienceSnapshot>;
  leave: () => Promise<unknown>;
  closing: boolean;
  closed?: Promise<void>;
}

/**
 * One upstream registration per playback generation. Repeated opens are local
 * heartbeats; they never refresh the upstream count by registering a second time.
 * Callers must use unique keys: only the most recent closed keys are retained.
 */
export class AudienceLeases {
  private readonly active = new Map<string, Lease>();
  private readonly tombstones = new Set<string>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxActive: number;
  private readonly maxClosed: number;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: AudienceLeaseOptions = {}) {
    this.ttlMs = positive(options.ttlMs ?? 90_000, 'ttlMs');
    this.timeoutMs = positive(options.timeoutMs ?? 8_000, 'timeoutMs');
    this.maxActive = positiveInteger(options.maxActive ?? 64, 'maxActive');
    this.maxClosed = positiveInteger(options.maxClosed ?? 256, 'maxClosed');
    this.now = options.now ?? (() => Date.now());
    this.timer = setInterval(() => this.expire(), positive(options.sweepMs ?? 15_000, 'sweepMs'));
    this.timer.unref();
  }

  open(
    key: string,
    join: () => Promise<AudienceSnapshot>,
    leave: () => Promise<unknown>,
  ): Promise<AudienceSnapshot> {
    if (this.stopped) return Promise.reject(new AppError('AUDIENCE_STOPPED', '观看人数服务已关闭', 503));
    this.expire();
    if (this.tombstones.has(key)) return Promise.reject(closedError());
    const current = this.active.get(key);
    if (current) {
      // A closing lease can outlive its bounded tombstone while awaiting I/O.
      if (current.closing) return Promise.reject(closedError());
      current.touchedAt = this.now();
      return current.opened;
    }
    if (this.active.size >= this.maxActive)
      return Promise.reject(new AppError('AUDIENCE_LIMIT', '同时登记的播放会话过多，请稍后重试', 429));

    // Defer the callback until after the lease is stored, including callbacks
    // that throw synchronously or re-enter this manager.
    const joined = this.withDeadline(join, '登记');
    const lease: Lease = {
      key,
      touchedAt: this.now(),
      joined,
      opened: joined,
      leave,
      closing: false,
    };
    lease.opened = joined.then(
      (snapshot) => {
        if (lease.closing) throw closedError();
        return snapshot;
      },
      (error: unknown) => {
        // A failed or timed-out response does not prove that the remote open
        // was rejected. Pair it with exactly one best-effort close.
        void this.release(lease).catch(() => {});
        throw error;
      },
    );
    // Keep abandoned HTTP consumers from producing an unhandled rejection;
    // consumers awaiting the original promise still receive the actual error.
    void lease.opened.catch(() => {});
    this.active.set(key, lease);
    return lease.opened;
  }

  close(key: string): Promise<void> {
    const lease = this.active.get(key);
    if (lease) return this.release(lease);
    // A close may reach the engine before its delayed open request.
    this.rememberClosed(key);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    clearInterval(this.timer);
    // One failed upstream close must not skip cleanup of the other sessions.
    this.shutdownPromise = Promise.allSettled(
      [...this.active.values()].map((lease) => this.release(lease)),
    ).then(() => undefined);
    return this.shutdownPromise;
  }

  private expire(): void {
    const now = this.now();
    for (const lease of this.active.values()) {
      if (!lease.closing && now - lease.touchedAt >= this.ttlMs) void this.release(lease).catch(() => {});
    }
  }

  private release(lease: Lease): Promise<void> {
    if (lease.closed) return lease.closed;
    lease.closing = true;
    this.rememberClosed(lease.key);
    lease.closed = lease.joined
      .catch(() => undefined)
      // Never cancel an already-issued join when its HTTP consumer leaves.
      // Wait for its response/deadline before issuing the matching close.
      .then(() => this.withDeadline(lease.leave, '离开'))
      .then(() => undefined)
      .finally(() => {
        if (this.active.get(lease.key) === lease) this.active.delete(lease.key);
        // Closing can take longer than hundreds of other close requests; keep
        // the newly finished key protected even if its first tombstone aged out.
        this.rememberClosed(lease.key);
      });
    void lease.closed.catch(() => {});
    return lease.closed;
  }

  private rememberClosed(key: string): void {
    this.tombstones.delete(key);
    this.tombstones.add(key);
    while (this.tombstones.size > this.maxClosed)
      this.tombstones.delete(this.tombstones.values().next().value!);
  }

  private withDeadline<T>(operation: () => Promise<T>, action: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError('AUDIENCE_TIMEOUT', `观看人数${action}请求超时`, 504)),
        this.timeoutMs,
      );
    });
    // Promise.race also observes a late rejection after the timeout has won.
    return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
  }
}

function closedError(): AppError {
  return new AppError('AUDIENCE_CLOSED', '该播放会话已离开，请使用新的播放会话', 409);
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  positive(value, name);
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer`);
  return value;
}
