import type { AppSettings, SourceModule } from '../../../packages/core/src/types';

interface Intent {
  sourceId: string;
  generation?: string;
  failed: boolean;
  notified: boolean;
}
interface Options {
  send: (module: SourceModule, sourceId: string, generation: string) => Promise<AppSettings>;
  saved?: (settings: AppSettings) => void;
  failed?: (module: SourceModule, error: unknown) => void;
  invalidated?: (refresh: boolean) => void;
}
interface Request {
  generation: string;
  promise: Promise<void>;
}

/** Serialize writes within a module while the server merges independent module changes atomically. */
export class SourcePreferences {
  private settings?: AppSettings;
  private pending = new Map<SourceModule, Intent>();
  private requests = new Map<SourceModule, Request>();
  private retired = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private options: Options) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  get ready() {
    return Boolean(this.settings);
  }
  read(module: SourceModule, fallback = '') {
    return (
      this.pending.get(module)?.sourceId ??
      (this.settings ? (this.settings.sourcePreferences?.[module] ?? '') : fallback)
    );
  }
  accept(settings: AppSettings) {
    if (settings.generation && this.retired.has(settings.generation)) return false;
    if (this.settings && (settings.revision ?? 0) < (this.settings.revision ?? 0)) return false;
    const oldGeneration = this.settings?.generation;
    const changedGeneration = oldGeneration && settings.generation && oldGeneration !== settings.generation;
    const discarded = changedGeneration ? this.retire(oldGeneration) : false;
    this.settings = settings;
    const bound: SourceModule[] = [];
    if (settings.generation)
      for (const [module, intent] of this.pending) {
        if (!intent.generation) {
          intent.generation = settings.generation;
          bound.push(module);
        }
      }
    this.changed();
    if (discarded) this.options.invalidated?.(false);
    for (const module of bound) void this.flush(module);
    return true;
  }
  private retire(generation: string) {
    const fresh = !this.retired.has(generation);
    this.retired.add(generation);
    let discarded = false;
    for (const [module, intent] of this.pending)
      if (intent.generation === generation) {
        this.pending.delete(module);
        discarded = true;
      }
    // Detach old workers so a new generation does not wait for a delayed old response.
    for (const [module, request] of this.requests)
      if (request.generation === generation) {
        this.requests.delete(module);
        discarded = true;
      }
    return fresh && discarded;
  }
  choose(module: SourceModule, sourceId: string) {
    if (!sourceId) return;
    const previous = this.pending.get(module);
    if (this.read(module) === sourceId && !previous?.failed) return;
    const generation = this.settings?.generation;
    this.pending.set(module, {
      sourceId,
      failed: false,
      notified: false,
      generation: generation && !this.retired.has(generation) ? generation : undefined,
    });
    this.changed();
    void this.flush(module);
  }
  retry() {
    for (const module of this.pending.keys()) void this.flush(module);
  }
  flush(module: SourceModule): Promise<void> {
    const active = this.requests.get(module);
    if (active) return active.promise;
    const generation = this.pending.get(module)?.generation;
    if (!generation || this.retired.has(generation)) return Promise.resolve();
    const request: Request = { generation, promise: Promise.resolve() };
    this.requests.set(module, request);
    request.promise = this.send(module, request).finally(() => {
      if (this.requests.get(module) !== request) return;
      this.requests.delete(module);
      const queued = this.pending.get(module);
      if (queued?.generation && !queued.failed) void this.flush(module);
    });
    return request.promise;
  }
  private async send(module: SourceModule, request: Request) {
    const active = () =>
      this.requests.get(module) === request &&
      this.settings?.generation === request.generation &&
      !this.retired.has(request.generation);
    while (active() && this.pending.has(module)) {
      const intent = this.pending.get(module)!;
      if (intent.generation !== request.generation) return;
      try {
        const saved = await this.options.send(module, intent.sourceId, request.generation);
        if (!active()) return;
        if (saved.generation !== request.generation) {
          this.accept(saved);
          return;
        }
        if (this.accept(saved)) this.options.saved?.(saved);
        if (this.pending.get(module) === intent) this.pending.delete(module);
        this.changed();
      } catch (error) {
        if (!active()) return;
        if (error && typeof error === 'object' && 'code' in error && error.code === 'SETTINGS_CHANGED') {
          if (this.retire(request.generation)) this.options.invalidated?.(true);
          this.changed();
          return;
        }
        if (this.pending.get(module) !== intent) continue;
        intent.failed = true;
        if (!intent.notified) this.options.failed?.(module, error);
        intent.notified = true;
        this.changed();
        return;
      }
    }
  }
}
