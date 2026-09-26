import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  episodeKey,
  type EpisodeLocator,
  type HistoryBoundary,
  type HistoryEntry,
  type HistoryPage,
  type HistoryVersion,
  type HistoryWrite,
  type SourceRef,
} from '../../core/src/types';
import { AppError } from './errors';

type Fence = { scope: string; version: number; deleted_at: string };
const seriesScope = (ref: SourceRef) => JSON.stringify(['series', ref.sourceId, ref.id]);
const entryScope = (key: string) => JSON.stringify(['episode', key]);
const decode = (rows: { data: string }[]) => rows.map((row) => JSON.parse(row.data) as HistoryEntry);

export class HistoryStore {
  private readonly profile: string;
  constructor(private db: Database.Database) {
    this.db
      .prepare("INSERT OR IGNORE INTO settings(key,data) VALUES ('history-profile',?)")
      .run(JSON.stringify(randomUUID()));
    const row = this.db.prepare("SELECT data FROM settings WHERE key = 'history-profile'").get() as {
      data: string;
    };
    try {
      const profile: unknown = JSON.parse(row.data);
      if (typeof profile !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(profile))
        throw new Error();
      this.profile = profile;
    } catch {
      throw new AppError('INVALID_PROFILE', '本地资料库身份无效，请从备份恢复至新的资料目录', 500);
    }
  }
  get(key: string): HistoryEntry | undefined {
    const row = this.db.prepare('SELECT data FROM history WHERE key = ?').get(key) as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list(limit = 1000) {
    return decode(
      this.db.prepare('SELECT data FROM history ORDER BY sampled_at DESC, key DESC LIMIT ?').all(limit) as {
        data: string;
      }[],
    );
  }
  recent() {
    return decode(
      this.db
        .prepare(
          `SELECT data FROM (
      SELECT data, sampled_at, key, row_number() OVER (
        PARTITION BY source_id, anime_id ORDER BY sampled_at DESC, key DESC
      ) AS rank FROM history
    ) WHERE rank = 1 ORDER BY sampled_at DESC, key DESC`,
        )
        .all() as { data: string }[],
    );
  }
  private refsClause(refs: SourceRef[]) {
    return {
      sql: '(' + refs.map(() => '(source_id = ? AND anime_id = ?)').join(' OR ') + ')',
      values: refs.flatMap((ref) => [ref.sourceId, ref.id]),
    };
  }
  related(refs: SourceRef[]) {
    if (!refs.length) return [];
    const clause = this.refsClause(refs);
    return decode(
      this.db
        .prepare(`SELECT data FROM history WHERE ${clause.sql} ORDER BY sampled_at DESC, key DESC`)
        .all(...clause.values) as { data: string }[],
    );
  }
  page(input: { query?: string; refs?: SourceRef[]; cursor?: string; limit?: number }): HistoryPage {
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    if (input.query) {
      conditions.push("json_extract(data, '$.card.title') LIKE ? ESCAPE '\\'");
      values.push('%' + input.query.replace(/[\\%_]/g, '\\$&') + '%');
    }
    if (input.refs?.length) {
      const clause = this.refsClause(input.refs);
      conditions.push(clause.sql);
      values.push(...clause.values);
    }
    const where = () => (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '');
    const total = (
      this.db.prepare('SELECT count(*) AS n FROM history' + where()).get(...values) as { n: number }
    ).n;
    if (input.cursor) {
      let cursor: { at: number; key: string };
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
        if (!Number.isSafeInteger(cursor.at) || typeof cursor.key !== 'string' || cursor.key.length > 1000)
          throw new Error();
      } catch {
        throw new AppError('INVALID_INPUT', '观看记录分页位置无效', 400);
      }
      conditions.push('(sampled_at < ? OR (sampled_at = ? AND key < ?))');
      values.push(cursor.at, cursor.at, cursor.key);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const rows = this.db
      .prepare(
        'SELECT data, sampled_at FROM history' + where() + ' ORDER BY sampled_at DESC, key DESC LIMIT ?',
      )
      .all(...values, limit + 1) as { data: string; sampled_at: number }[];
    const items = decode(rows.slice(0, limit));
    const last = items.at(-1);
    return {
      items,
      total,
      ...(rows.length > limit && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ at: rows[limit - 1].sampled_at, key: last.key }),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  private fences(locator: EpisodeLocator): Fence[] {
    return this.db
      .prepare('SELECT * FROM history_fences WHERE scope IN (?, ?, ?)')
      .all(
        'all',
        seriesScope({ sourceId: locator.sourceId, id: locator.animeId }),
        entryScope(episodeKey(locator)),
      ) as Fence[];
  }
  version(locator: EpisodeLocator): HistoryVersion {
    const fences = new Map(this.fences(locator).map((row) => [row.scope, row.version]));
    return {
      profile: this.profile,
      all: fences.get('all') ?? 0,
      series: fences.get(seriesScope({ sourceId: locator.sourceId, id: locator.animeId })) ?? 0,
      episode: fences.get(entryScope(episodeKey(locator))) ?? 0,
    };
  }
  save(input: HistoryWrite): HistoryEntry {
    if (
      input.episode.locator.sourceId !== input.card.sourceId ||
      input.episode.locator.animeId !== input.card.id
    )
      throw new AppError('INVALID_INPUT', '剧集与番剧不匹配', 400);
    const version = this.version(input.episode.locator);
    const stale = input.version
      ? (input.version.profile !== undefined && input.version.profile !== version.profile) ||
        (['all', 'series', 'episode'] as const).some((key) => version[key] !== input.version![key])
      : this.fences(input.episode.locator).some(
          (row) => Date.parse(input.capturedAt) <= Date.parse(row.deleted_at),
        );
    if (stale) throw new AppError('HISTORY_CHANGED', '观看记录已被删除或恢复，请重新读取进度后继续', 409);
    const key = episodeKey(input.episode.locator);
    const existing = this.get(key);
    if (existing?.capturedAt && Date.parse(input.capturedAt) <= Date.parse(existing.capturedAt))
      return existing;
    const { version: _version, ...data } = input;
    const entry: HistoryEntry = {
      ...data,
      key,
      position: input.duration > 0 ? Math.min(input.position, input.duration) : input.position,
      updatedAt: new Date().toISOString(),
    };
    this.insert(entry);
    this.db
      .prepare(
        'DELETE FROM history WHERE key IN (SELECT key FROM history ORDER BY sampled_at DESC, key DESC LIMIT -1 OFFSET 50000)',
      )
      .run();
    return entry;
  }
  private insert(entry: HistoryEntry) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO history(key, updated_at, data, source_id, anime_id, sampled_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.key,
        entry.updatedAt,
        JSON.stringify(entry),
        entry.card.sourceId,
        entry.card.id,
        Date.parse(entry.capturedAt ?? entry.updatedAt),
      );
  }
  private bump(scope: string) {
    this.db
      .prepare(
        'INSERT INTO history_fences(scope, version, deleted_at) VALUES (?, 1, ?) ON CONFLICT(scope) DO UPDATE SET version = version + 1, deleted_at = excluded.deleted_at',
      )
      .run(scope, new Date().toISOString());
  }
  boundary(selection: { key?: string; refs?: SourceRef[] } = {}): HistoryBoundary {
    const value = (scope: string) =>
      (
        this.db.prepare('SELECT version FROM history_fences WHERE scope = ?').get(scope) as
          { version: number } | undefined
      )?.version ?? 0;
    const epoch = value('all');
    if (selection.key)
      return { epoch, episode: { key: selection.key, version: value(entryScope(selection.key)) } };
    if (selection.refs?.length)
      return { epoch, series: selection.refs.map((ref) => ({ ...ref, version: value(seriesScope(ref)) })) };
    return { epoch, all: epoch };
  }
  delete(selection: { key?: string; refs?: SourceRef[] } = {}) {
    return this.db.transaction(() => {
      if (selection.key) {
        this.bump(entryScope(selection.key));
        return this.db.prepare('DELETE FROM history WHERE key = ?').run(selection.key).changes;
      }
      if (selection.refs?.length) {
        for (const ref of selection.refs) this.bump(seriesScope(ref));
        const clause = this.refsClause(selection.refs);
        return this.db.prepare('DELETE FROM history WHERE ' + clause.sql).run(...clause.values).changes;
      }
      this.bump('all');
      this.db.prepare("DELETE FROM history_fences WHERE scope != 'all'").run();
      return this.db.prepare('DELETE FROM history').run().changes;
    })();
  }
  /** Called inside the surrounding backup transaction. Never import old deletion versions. */
  replace(entries: HistoryEntry[]) {
    this.delete();
    for (const entry of entries) this.insert(entry);
  }
}
