import { abortable } from './errors';

interface Pending {
  promise: Promise<unknown>;
  controller: AbortController;
  users: number;
  settled: boolean;
  refresh?: boolean;
}

/** Share one upstream read while each caller keeps its own cancellation lifetime. */
export class RequestCache {
  private values = new Map<string, { value: unknown; expires: number }>();
  private pending = new Map<string, Pending>();
  private generation = 0;
  private reads = new Map<string, { generation: number; pending: number }>();

  constructor(private limit = 500) {}

  peek<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return;
    this.values.delete(key);
    if (entry.expires <= Date.now()) return;
    this.values.set(key, entry);
    return entry.value as T;
  }

  clear() {
    this.generation++;
    this.values.clear();
    // Existing readers can finish, but cannot repopulate the cleared cache.
    this.pending.clear();
    this.reads.clear();
  }

  async load<T>(
    key: string,
    read: (signal: AbortSignal) => Promise<T>,
    options: {
      signal?: AbortSignal;
      refresh?: boolean;
      ttl?: number;
      timeout?: number;
      deduplicate?: boolean;
    } = {},
  ): Promise<T> {
    options.signal?.throwIfAborted();
    const cached = options.refresh ? undefined : this.peek<T>(key);
    if (cached !== undefined) return cached;
    let task = options.deduplicate === false ? undefined : this.pending.get(key);
    if (options.refresh && task && !task.refresh) task = undefined;
    if (!task) {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeout ?? 25_000)]);
      const generation = this.generation;
      let reads = this.reads.get(key);
      if (!reads) {
        reads = { generation: 0, pending: 0 };
        this.reads.set(key, reads);
      }
      if (options.refresh) reads.generation++;
      reads.pending++;
      const stamp = reads.generation;
      const next: Pending = {
        controller,
        users: 0,
        settled: false,
        refresh: Boolean(options.refresh),
        promise: Promise.resolve(),
      };
      next.promise = Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return abortable(read(signal), signal);
        })
        .then((value) => {
          if (
            !signal.aborted &&
            generation === this.generation &&
            this.reads.get(key) === reads &&
            stamp === reads.generation
          ) {
            this.values.delete(key);
            if (this.values.size >= this.limit) this.values.delete(this.values.keys().next().value!);
            this.values.set(key, { value, expires: Date.now() + (options.ttl ?? 300_000) });
          }
          return value;
        })
        .finally(() => {
          next.settled = true;
          if (this.pending.get(key) === next) this.pending.delete(key);
          if (--reads.pending === 0 && this.reads.get(key) === reads) this.reads.delete(key);
        });
      task = next;
      if (options.deduplicate !== false) this.pending.set(key, task);
    }
    task.users++;
    try {
      return (await (options.signal ? abortable(task.promise, options.signal) : task.promise)) as T;
    } finally {
      task.users--;
      if (!task.users && !task.settled) {
        if (this.pending.get(key) === task) this.pending.delete(key);
        task.controller.abort();
      }
    }
  }
}
