import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BACKUP_MAX_BYTES,
  episodeKey,
  refKey,
  type AnimeCard,
  type AppSettings,
  type HistoryEntry,
  type HistoryWrite,
  type LibraryEntry,
  type SourceRef,
  type SourceModule,
  type SearchHistoryEntry,
  type WatchStatus,
  type BangumiLink,
  type LibraryLinkPreview,
} from '../../core/src/types';
import { pendingUpdateCount } from '../../core/src/library';
import { AppError } from './errors';
import { HistoryStore } from './history-store';
import { BackupFiles, backupPreview, validateBackup } from './backups';

const defaults: AppSettings = {
  autoNext: true,
  playbackRate: 1,
  volume: 0.8,
  appearance: 'light',
  danmaku: { enabled: false, opacity: 0.85, fontScale: 1 },
  revision: 0,
};
export const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE library (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE history (key TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX history_updated ON history(updated_at DESC);
CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE source_settings (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, priority INTEGER NOT NULL);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE history ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
ALTER TABLE history ADD COLUMN anime_id TEXT NOT NULL DEFAULT '';
ALTER TABLE history ADD COLUMN sampled_at INTEGER NOT NULL DEFAULT 0;
UPDATE history SET source_id = json_extract(data, '$.card.sourceId'), anime_id = json_extract(data, '$.card.id'),
  sampled_at = CAST(round((julianday(COALESCE(json_extract(data, '$.capturedAt'), updated_at)) - 2440587.5) * 86400000) AS INTEGER);
CREATE INDEX history_sampled ON history(sampled_at DESC, key DESC);
CREATE INDEX history_source ON history(source_id, anime_id, sampled_at DESC, key DESC);
CREATE TABLE history_fences (scope TEXT PRIMARY KEY, version INTEGER NOT NULL, deleted_at TEXT NOT NULL);
`,
  },
];

export class Store {
  readonly db: Database.Database;
  readonly historyData: HistoryStore;
  readonly backups: BackupFiles;
  /** A restore is a new profile generation, including when identical IDs are imported. */
  libraryEpoch = 0;
  private refVersions = new Map<string, number>();
  private undo = new Map<
    string,
    { entry: LibraryEntry; expires: number; epoch: number; versions: number[] }
  >();
  private linkPreviews = new Map<
    string,
    {
      input: { card: AnimeCard; target: AnimeCard; libraryId?: string };
      signature: string;
      expires: number;
      refs: SourceRef[];
    }
  >();
  constructor(
    readonly filename: string,
    migrationList = migrations,
  ) {
    this.backups = new BackupFiles(filename);
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    if (filename !== ':memory:' && existsSync(filename)) {
      const probe = new Database(filename);
      const version = probe.pragma('user_version', { simple: true }) as number;
      probe.pragma('wal_checkpoint(TRUNCATE)');
      probe.close();
      if (migrationList.some((m) => m.version > version))
        copyFileSync(filename, filename + '.before-migration');
    }
    this.db = new Database(filename);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      const current = this.db.pragma('user_version', { simple: true }) as number;
      if (current > Math.max(...migrationList.map((m) => m.version)))
        throw new AppError('DB_TOO_NEW', '数据来自更新版本的应用，请更新后再打开', 500);
      this.db.transaction(() => {
        for (const migration of migrationList
          .filter((m) => m.version > current)
          .sort((a, b) => a.version - b.version)) {
          this.db.exec(migration.sql);
          this.db.pragma(`user_version = ${migration.version}`);
        }
      })();
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.historyData = new HistoryStore(this.db);
      this.db
        .prepare("INSERT OR IGNORE INTO settings(key,data) VALUES ('settings-generation',?)")
        .run(JSON.stringify(randomUUID()));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  library(): LibraryEntry[] {
    return (this.db.prepare('SELECT data FROM library').all() as { data: string }[])
      .map((r) => JSON.parse(r.data))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  getLibrary(id: string): LibraryEntry {
    const row = this.db.prepare('SELECT data FROM library WHERE id = ?').get(id) as
      { data: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', '追番记录不存在', 404);
    return JSON.parse(row.data);
  }
  saveLibrary(entry: LibraryEntry) {
    const row = this.db.prepare('SELECT data FROM library WHERE id = ?').get(entry.id) as
      { data: string } | undefined;
    const before = row ? (JSON.parse(row.data) as LibraryEntry) : undefined;
    const sameRefs =
      before &&
      refKey(before.card) === refKey(entry.card) &&
      JSON.stringify(before.refs.map(refKey).sort()) === JSON.stringify(entry.refs.map(refKey).sort());
    const saved = {
      ...entry,
      revision: randomUUID(),
      associationRevision: sameRefs ? (before.associationRevision ?? randomUUID()) : randomUUID(),
    };
    this.db
      .prepare('INSERT OR REPLACE INTO library(id, data) VALUES (?, ?)')
      .run(saved.id, JSON.stringify(saved));
    this.touchRefs(saved.refs);
    return saved;
  }
  addLibrary(card: AnimeCard, status: WatchStatus): LibraryEntry {
    return this.db.transaction(() => {
      const found = this.library().find((entry) => entry.refs.some((ref) => refKey(ref) === refKey(card)));
      if (found) {
        if (!found.refs.some((ref) => refKey(ref) === refKey(card))) {
          if (found.refs.length >= 30)
            throw new AppError('LIMIT_REACHED', '同一追番最多关联 30 个来源条目', 409);
          found.refs.push({ sourceId: card.sourceId, id: card.id });
        }
        found.status = status;
        found.updatedAt = new Date().toISOString();
        return this.saveLibrary(found);
      }
      const now = new Date().toISOString();
      return this.saveLibrary({
        id: randomUUID(),
        card,
        refs: [{ sourceId: card.sourceId, id: card.id }],
        status,
        addedAt: now,
        updatedAt: now,
        latestCount: 0,
        seenCount: 0,
      });
    })();
  }
  updateLibrary(
    id: string,
    patch: {
      status?: WatchStatus;
      ref?: SourceRef;
      unlinkRef?: SourceRef;
      markSeen?: boolean;
      revision?: string;
    },
  ): LibraryEntry {
    return this.db.transaction(() => {
      const entry = this.getLibrary(id);
      if (patch.revision && patch.revision !== entry.revision)
        throw new AppError('LIBRARY_CONFLICT', '追番记录已变化，请刷新后重试', 409);
      if (patch.status) entry.status = patch.status;
      if (patch.markSeen) {
        entry.seenCount = entry.latestCount;
        entry.updates = [];
        entry.unidentifiedUpdateCount = 0;
      }
      if (patch.unlinkRef) {
        if (refKey(patch.unlinkRef) === refKey(entry.card))
          throw new AppError('PRIMARY_SOURCE', '主来源不能解除，可在其他已关联来源继续观看', 409);
        if (!entry.refs.some((ref) => refKey(ref) === refKey(patch.unlinkRef!)))
          throw new AppError('NOT_FOUND', '这个来源尚未关联', 404);
        entry.refs = entry.refs.filter((ref) => refKey(ref) !== refKey(patch.unlinkRef!));
        entry.episodeSnapshots = entry.episodeSnapshots?.filter(
          (snapshot) => refKey(snapshot) !== refKey(patch.unlinkRef!),
        );
        entry.updates = entry.updates?.filter((update) => refKey(update) !== refKey(patch.unlinkRef!));
        this.touchRefs([patch.unlinkRef]);
      }
      if (patch.ref && !entry.refs.some((r) => refKey(r) === refKey(patch.ref!))) {
        // Explicit user linking joins existing collections and preserves their source references.
        const others = this.library().filter(
          (other) => other.id !== id && other.refs.some((r) => refKey(r) === refKey(patch.ref!)),
        );
        entry.refs.push(patch.ref);
        for (const other of others)
          for (const ref of other.refs)
            if (!entry.refs.some((r) => refKey(r) === refKey(ref))) entry.refs.push(ref);
        if (entry.refs.length > 30)
          throw new AppError('LIMIT_REACHED', '同一追番最多关联 30 个来源条目', 409);
        this.mergeEpisodeData(entry, others);
        for (const other of others) this.removeLibrary(other.id);
      }
      entry.updatedAt = new Date().toISOString();
      return this.saveLibrary(entry);
    })();
  }
  removeLibrary(id: string) {
    const entry = this.getLibrary(id);
    this.db.prepare('DELETE FROM library WHERE id = ?').run(id);
    this.touchRefs(entry.refs);
  }
  removeLibraryWithUndo(id: string) {
    const entry = this.getLibrary(id);
    this.removeLibrary(id);
    const token = randomUUID(),
      expires = Date.now() + 60_000;
    this.pruneTokens();
    this.trackRefs(entry.refs);
    this.undo.set(token, {
      entry,
      expires,
      epoch: this.libraryEpoch,
      versions: entry.refs.map((ref) => this.refVersions.get(refKey(ref)) ?? 0),
    });
    return { deleted: true, undoToken: token, undoExpiresAt: new Date(expires).toISOString() };
  }
  undoLibrary(token: string) {
    const undo = this.undo.get(token);
    if (!undo || undo.expires < Date.now())
      throw new AppError('UNDO_EXPIRED', '撤销时间已过，可重新追番', 409);
    if (
      undo.epoch !== this.libraryEpoch ||
      undo.entry.refs.some(
        (ref, index) => (this.refVersions.get(refKey(ref)) ?? 0) !== undo.versions[index],
      ) ||
      this.library().some(
        (entry) =>
          entry.id === undo.entry.id ||
          entry.refs.some((ref) => undo.entry.refs.some((saved) => refKey(saved) === refKey(ref))),
      )
    )
      throw new AppError('LIBRARY_CONFLICT', '相关追番已发生变化，撤销不会覆盖新的资料', 409);
    const restored = this.saveLibrary({ ...undo.entry, updatedAt: new Date().toISOString() });
    this.undo.delete(token);
    return restored;
  }
  private pruneTokens() {
    for (const [token, value] of this.undo) if (value.expires < Date.now()) this.undo.delete(token);
    for (const [token, value] of this.linkPreviews)
      if (value.expires < Date.now()) this.linkPreviews.delete(token);
    while (this.undo.size >= 100) this.undo.delete(this.undo.keys().next().value!);
    while (this.linkPreviews.size >= 100) this.linkPreviews.delete(this.linkPreviews.keys().next().value!);
    const retained = new Set(
      [...this.undo.values()]
        .flatMap((value) => value.entry.refs)
        .concat([...this.linkPreviews.values()].flatMap((value) => value.refs))
        .map(refKey),
    );
    for (const key of this.refVersions.keys()) if (!retained.has(key)) this.refVersions.delete(key);
  }
  private trackRefs(refs: SourceRef[]) {
    for (const ref of refs) if (!this.refVersions.has(refKey(ref))) this.refVersions.set(refKey(ref), 0);
  }
  private touchRefs(refs: SourceRef[]) {
    for (const ref of refs)
      if (this.refVersions.has(refKey(ref)))
        this.refVersions.set(refKey(ref), this.refVersions.get(refKey(ref))! + 1);
  }
  private linkShape(input: { card: AnimeCard; target: AnimeCard; libraryId?: string }) {
    const all = this.library();
    const base = input.libraryId
      ? this.getLibrary(input.libraryId)
      : (all.find((entry) => entry.refs.some((ref) => refKey(ref) === refKey(input.card))) ?? null);
    if (base && !base.refs.some((ref) => refKey(ref) === refKey(input.card)))
      throw new AppError('LIBRARY_CONFLICT', '关联起点已变化，请返回详情重新选择', 409);
    const merged = all.filter(
      (entry) => entry.id !== base?.id && entry.refs.some((ref) => refKey(ref) === refKey(input.target)),
    );
    const refs = [
      ...new Map(
        [...(base?.refs ?? [input.card]), input.target, ...merged.flatMap((entry) => entry.refs)].map(
          (ref) => [refKey(ref), { sourceId: ref.sourceId, id: ref.id }],
        ),
      ).values(),
    ];
    if (refs.length > 30) throw new AppError('LIMIT_REACHED', '同一追番最多关联 30 个来源条目', 409);
    return {
      base,
      merged,
      refs,
      status: base?.status ?? merged[0]?.status ?? ('watching' as WatchStatus),
      creates: !base,
    };
  }
  private linkSignature(shape: ReturnType<Store['linkShape']>) {
    return JSON.stringify([
      this.libraryEpoch,
      [shape.base, ...shape.merged].filter(Boolean).map((entry) => [entry!.id, entry!.revision, entry!.refs]),
      shape.refs.map((ref) => [refKey(ref), this.refVersions.get(refKey(ref)) ?? 0]),
    ]);
  }
  previewLibraryLink(input: { card: AnimeCard; target: AnimeCard; libraryId?: string }): LibraryLinkPreview {
    if (refKey(input.card) === refKey(input.target))
      throw new AppError('INVALID_LINK', '请选择不同的来源条目', 400);
    const shape = this.linkShape(input),
      token = randomUUID(),
      expires = Date.now() + 300_000;
    this.pruneTokens();
    this.trackRefs(shape.refs);
    this.linkPreviews.set(token, { input, signature: this.linkSignature(shape), expires, refs: shape.refs });
    return { ...shape, token, expiresAt: new Date(expires).toISOString() };
  }
  private mergeEpisodeData(entry: LibraryEntry, others: LibraryEntry[]) {
    const all = [entry, ...others];
    const unidentifiedUpdateCount = all.reduce(
      (sum, item) =>
        sum + (item.updates === undefined ? pendingUpdateCount(item) : (item.unidentifiedUpdateCount ?? 0)),
      0,
    );
    entry.episodeSnapshots = [
      ...new Map(
        all.flatMap((item) => item.episodeSnapshots ?? []).map((snapshot) => [refKey(snapshot), snapshot]),
      ).values(),
    ];
    entry.updates = [
      ...new Map(all.flatMap((item) => item.updates ?? []).map((update) => [update.key, update])).values(),
    ];
    entry.unidentifiedUpdateCount = unidentifiedUpdateCount;
    entry.latestCount = Math.max(...all.map((item) => item.latestCount));
    entry.seenCount = Math.max(0, entry.latestCount - pendingUpdateCount(entry));
    entry.checkedAt = all
      .map((item) => item.checkedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    entry.contentUpdatedAt = all
      .map((item) => item.contentUpdatedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
  }
  confirmLibraryLink(token: string): LibraryEntry {
    const preview = this.linkPreviews.get(token);
    if (!preview || preview.expires < Date.now())
      throw new AppError('LINK_EXPIRED', '关联预览已过期，请重新预览', 409);
    return this.db.transaction(() => {
      const shape = this.linkShape(preview.input);
      if (preview.signature !== this.linkSignature(shape))
        throw new AppError('LIBRARY_CONFLICT', '关联内容已变化，请重新预览合并结果', 409);
      const now = new Date().toISOString();
      const entry: LibraryEntry = shape.base ?? {
        id: randomUUID(),
        card: preview.input.card,
        refs: [],
        status: shape.status,
        addedAt: now,
        updatedAt: now,
        latestCount: 0,
        seenCount: 0,
      };
      this.mergeEpisodeData(entry, shape.merged);
      entry.refs = shape.refs;
      entry.updatedAt = now;
      for (const other of shape.merged) this.removeLibrary(other.id);
      const saved = this.saveLibrary(entry);
      this.linkPreviews.delete(token);
      return saved;
    })();
  }
  history(limit = 1000): HistoryEntry[] {
    return this.historyData.list(limit);
  }
  historyByKey(key: string): HistoryEntry | undefined {
    return this.historyData.get(key);
  }
  saveHistory(input: HistoryWrite): HistoryEntry {
    return this.historyData.save(input);
  }
  clearHistory() {
    this.historyData.delete();
  }
  searchHistory(): SearchHistoryEntry[] {
    const row = this.db.prepare("SELECT data FROM settings WHERE key = 'search-history'").get() as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : [];
  }
  private saveSearchHistory(entries: SearchHistoryEntry[]) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings(key,data) VALUES ('search-history',?)")
      .run(JSON.stringify(entries.slice(0, 20)));
  }
  rememberSearch(input: string) {
    const keyword = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!keyword || keyword.length > 150) return;
    this.saveSearchHistory([
      { keyword, searchedAt: new Date().toISOString() },
      ...this.searchHistory().filter((e) => e.keyword.toLocaleLowerCase() !== keyword.toLocaleLowerCase()),
    ]);
  }
  clearSearchHistory(keyword?: string) {
    this.saveSearchHistory(keyword ? this.searchHistory().filter((e) => e.keyword !== keyword) : []);
    return this.searchHistory();
  }
  bangumiLinks(): BangumiLink[] {
    const row = this.db.prepare("SELECT data FROM settings WHERE key = 'bangumi-links'").get() as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : [];
  }
  private saveBangumiLinks(links: BangumiLink[]) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings(key,data) VALUES ('bangumi-links',?)")
      .run(JSON.stringify(links));
  }
  linkBangumi(ref: SourceRef, subjectId?: string) {
    const links = this.bangumiLinks().filter((entry) => refKey(entry) !== refKey(ref));
    if (subjectId) {
      if (links.length >= 10000) throw new AppError('LIMIT_REACHED', '评分关联数量已达上限。', 409);
      links.push({ sourceId: ref.sourceId, id: ref.id, subjectId });
    }
    this.saveBangumiLinks(links);
  }
  settings(): AppSettings {
    const row = this.db.prepare("SELECT data FROM settings WHERE key = 'app'").get() as
      { data: string } | undefined;
    const stored = row ? JSON.parse(row.data) : {};
    const generation = this.db
      .prepare("SELECT data FROM settings WHERE key = 'settings-generation'")
      .get() as { data: string };
    return {
      ...defaults,
      ...stored,
      revision: stored.revision ?? 0,
      generation: JSON.parse(generation.data),
    };
  }
  private persistSettings(settings: AppSettings) {
    const { generation: _generation, ...stored } = settings;
    this.db
      .prepare("INSERT OR REPLACE INTO settings(key, data) VALUES ('app', ?)")
      .run(JSON.stringify(stored));
    return this.settings();
  }
  saveSettings(input: AppSettings) {
    const current = this.settings();
    if (input.generation !== undefined && input.generation !== current.generation)
      throw new AppError('SETTINGS_CHANGED', '资料已恢复，请重新读取设置后再修改', 409);
    if ((input.revision ?? 0) !== current.revision)
      throw new AppError('SETTINGS_CONFLICT', '设置已在另一个窗口更新，请重试', 409);
    return this.persistSettings({ ...input, revision: current.revision + 1 });
  }
  saveSourcePreference(module: SourceModule, sourceId: string, generation?: string) {
    return this.db.transaction(() => {
      const current = this.settings();
      if (generation !== undefined && generation !== current.generation)
        throw new AppError('SETTINGS_CHANGED', '资料已恢复，请重新读取设置后再修改', 409);
      if (current.sourcePreferences?.[module] === sourceId) return current;
      return this.saveSettings({
        ...current,
        sourcePreferences: { ...current.sourcePreferences, [module]: sourceId },
      });
    })();
  }
  sourceSettings(id: string, priority: number) {
    const row = this.db.prepare('SELECT enabled, priority FROM source_settings WHERE id = ?').get(id) as
      { enabled: number; priority: number } | undefined;
    return row ? { enabled: Boolean(row.enabled), priority: row.priority } : { enabled: true, priority };
  }
  saveSourceSettings(id: string, enabled: boolean, priority: number) {
    this.db
      .prepare('INSERT OR REPLACE INTO source_settings(id, enabled, priority) VALUES (?, ?, ?)')
      .run(id, enabled ? 1 : 0, priority);
  }
  export() {
    const { generation: _generation, ...portableSettings } = this.settings();
    const sourceSettings = (
      this.db.prepare('SELECT id, enabled, priority FROM source_settings ORDER BY priority').all() as {
        id: string;
        enabled: number;
        priority: number;
      }[]
    ).map((s) => ({ ...s, enabled: Boolean(s.enabled) }));
    const payload = {
      format: 'revanime' as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      library: this.library(),
      history: this.history(50000),
      settings: portableSettings,
      sourceSettings,
      searchHistory: this.searchHistory(),
      bangumiLinks: this.bangumiLinks(),
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > BACKUP_MAX_BYTES)
      throw new AppError('BACKUP_TOO_LARGE', '备份超过 64 MB，无法在本机恢复', 413);
    return payload;
  }
  previewBackup(input: unknown) {
    return backupPreview(input, {
      libraryCount: this.library().length,
      historyCount: this.history(50000).length,
    });
  }
  restore(input: unknown) {
    const data = validateBackup(input);
    const backupName = this.backups.save(this.export());
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM library').run();
      this.historyData.replace(data.history);
      for (const entry of data.library) this.saveLibrary(entry);
      // A restore is a new local write, not a return to an old concurrency token.
      this.db
        .prepare("UPDATE settings SET data = ? WHERE key = 'settings-generation'")
        .run(JSON.stringify(randomUUID()));
      this.persistSettings({ ...data.settings, revision: (this.settings().revision ?? 0) + 1 });
      this.saveSearchHistory(data.searchHistory ?? []);
      this.saveBangumiLinks(data.bangumiLinks ?? []);
      if (data.sourceSettings) {
        this.db.prepare('DELETE FROM source_settings').run();
        for (const source of data.sourceSettings)
          this.saveSourceSettings(source.id, source.enabled, source.priority);
      }
    })();
    this.libraryEpoch++;
    this.refVersions.clear();
    this.undo.clear();
    this.linkPreviews.clear();
    return {
      restored: true,
      backupName,
      backupDirectory: this.backups.directory,
      boundary: this.historyData.boundary(),
    };
  }
}
