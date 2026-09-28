import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  BACKUP_MAX_BYTES,
  episodeKey,
  refKey,
  type BackupFile,
  type BackupPreview,
} from '../../core/src/types';
import { AppError } from './errors';
import { backupSchema, parse } from './validation';

const filenamePattern = /^before-restore-\d+(?:-[a-f\d-]{36})?\.json$/;

/** Used by preview and restore so their acceptance criteria cannot drift. */
export function validateBackup(input: unknown) {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input) ?? '');
  } catch {
    throw new AppError('INVALID_BACKUP', '备份不是有效的 JSON 数据', 400);
  }
  if (bytes > BACKUP_MAX_BYTES) throw new AppError('BACKUP_TOO_LARGE', '备份超过 64 MB，无法在本机恢复', 413);
  const data = parse(backupSchema, input);
  for (const entry of data.history) {
    if (
      episodeKey(entry.episode.locator) !== entry.key ||
      entry.card.id !== entry.episode.locator.animeId ||
      entry.card.sourceId !== entry.episode.locator.sourceId
    )
      throw new AppError('INVALID_BACKUP', '备份中的剧集记录不一致', 400);
  }
  if (
    new Set(data.library.map((entry) => entry.id)).size !== data.library.length ||
    new Set(data.history.map((entry) => entry.key)).size !== data.history.length
  )
    throw new AppError('INVALID_BACKUP', '备份含有重复记录', 400);
  const refs = new Set<string>();
  for (const entry of data.library) {
    if (!entry.refs.some((ref) => refKey(ref) === refKey(entry.card)) || entry.seenCount > entry.latestCount)
      throw new AppError('INVALID_BACKUP', '备份中的追番记录不一致', 400);
    const ownRefs = new Set(entry.refs.map(refKey));
    for (const ref of entry.refs) {
      const key = refKey(ref);
      if (refs.has(key)) throw new AppError('INVALID_BACKUP', '备份含有重复来源关联', 400);
      refs.add(key);
    }
    const snapshots = entry.episodeSnapshots ?? [];
    if (new Set(snapshots.map(refKey)).size !== snapshots.length)
      throw new AppError('INVALID_BACKUP', '备份含有重复的剧集清单', 400);
    for (const snapshot of snapshots) {
      if (
        !ownRefs.has(refKey(snapshot)) ||
        new Set(snapshot.episodes.map((episode) => episode.key)).size !== snapshot.episodes.length
      )
        throw new AppError('INVALID_BACKUP', '备份的剧集清单与来源不一致', 400);
      for (const episode of snapshot.episodes)
        if (
          refKey(episode) !== refKey(snapshot) ||
          episode.locator.sourceId !== snapshot.sourceId ||
          episode.locator.animeId !== snapshot.id
        )
          throw new AppError('INVALID_BACKUP', '备份的剧集清单与来源不一致', 400);
    }
    if (new Set((entry.updates ?? []).map((episode) => episode.key)).size !== (entry.updates?.length ?? 0))
      throw new AppError('INVALID_BACKUP', '备份含有重复的新增剧集', 400);
    for (const update of entry.updates ?? [])
      if (
        !ownRefs.has(refKey(update)) ||
        update.locator.sourceId !== update.sourceId ||
        update.locator.animeId !== update.id
      )
        throw new AppError('INVALID_BACKUP', '备份的新增剧集与来源不一致', 400);
  }
  if (data.bangumiLinks && new Set(data.bangumiLinks.map(refKey)).size !== data.bangumiLinks.length)
    throw new AppError('INVALID_BACKUP', '备份含有重复的 Bangumi 关联', 400);
  if (
    data.sourceSettings &&
    new Set(data.sourceSettings.map((source) => source.id)).size !== data.sourceSettings.length
  )
    throw new AppError('INVALID_BACKUP', '备份含有重复来源设置', 400);
  return data;
}

export function backupPreview(input: unknown, current: BackupPreview['current']): BackupPreview {
  const data = validateBackup(input);
  return {
    fingerprint: backupFingerprint(data),
    exportedAt: data.exportedAt,
    libraryCount: data.library.length,
    historyCount: data.history.length,
    searchHistoryCount: data.searchHistory?.length ?? 0,
    sourceCount: data.sourceSettings?.length ?? 0,
    current,
    replace: [
      '追番与来源关联',
      '观看记录',
      '播放器与外观设置',
      '搜索记录',
      'Bangumi 评分关联',
      ...(data.sourceSettings ? ['来源启用状态与顺序'] : []),
    ],
  };
}

export const backupFingerprint = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

export class BackupFiles {
  readonly directory: string | null;
  constructor(filename: string) {
    this.directory = filename === ':memory:' ? null : resolve(dirname(filename), 'backups');
  }
  private directoryPath(create = false): string | null {
    if (!this.directory) return null;
    if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      const stat = lstatSync(this.directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(this.directory) !== join(realpathSync(dirname(this.directory)), 'backups')
      )
        throw new AppError('INVALID_BACKUP_PATH', '自动备份目录必须是资料目录内的实际文件夹', 400);
      return realpathSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) return null;
      throw error;
    }
  }
  save(input: unknown): string | undefined {
    const dir = this.directoryPath(true);
    if (!dir) return undefined;
    const name = `before-restore-${Date.now()}-${randomUUID()}.json`;
    writeFileSync(join(dir, name), JSON.stringify(input), { mode: 0o600, flag: 'wx', flush: true });
    return name;
  }
  read(name: string) {
    if (!filenamePattern.test(name)) throw new AppError('INVALID_BACKUP_PATH', '自动备份文件名无效', 400);
    const dir = this.directoryPath();
    if (!dir) throw new AppError('NOT_FOUND', '自动备份不存在', 404);
    const path = join(dir, name);
    let fd: number;
    try {
      // O_NOFOLLOW is unavailable on Windows, so reject links explicitly as well.
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new AppError('INVALID_BACKUP_PATH', '备份必须是常规文件', 400);
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError('NOT_FOUND', '自动备份不存在', 404);
      throw new AppError('INVALID_BACKUP_PATH', '无法读取自动备份文件', 400);
    }
    try {
      const stat = fstatSync(fd);
      const entry = lstatSync(path);
      // Check the opened descriptor against the path again before reading any bytes.
      if (
        !stat.isFile() ||
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        stat.dev !== entry.dev ||
        stat.ino !== entry.ino ||
        realpathSync(path) !== path
      )
        throw new AppError('INVALID_BACKUP_PATH', '备份必须是资料目录内的常规文件', 400);
      if (stat.size > BACKUP_MAX_BYTES)
        throw new AppError('BACKUP_TOO_LARGE', '备份超过 64 MB，无法在本机恢复', 413);
      const buffer = Buffer.alloc(Math.min(stat.size + 1, BACKUP_MAX_BYTES + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (!read) break;
        bytes += read;
      }
      if (bytes > stat.size) throw new AppError('BACKUP_CHANGED', '备份读取期间发生变化，请重试', 409);
      let input: unknown;
      try {
        input = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
      } catch {
        throw new AppError('INVALID_BACKUP', '备份文件已损坏或不是有效的 JSON', 400);
      }
      return { data: validateBackup(input), bytes, createdAt: stat.mtime.toISOString() };
    } finally {
      closeSync(fd);
    }
  }
  list(): { directory: string | null; items: BackupFile[] } {
    const dir = this.directoryPath();
    if (!dir) return { directory: this.directory, items: [] };
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && filenamePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b.split('-')[2]) - Number(a.split('-')[2]) || b.localeCompare(a))
      .slice(0, 10);
    const items = names.map((name): BackupFile => {
      try {
        const { data, bytes, createdAt } = this.read(name);
        return {
          name,
          createdAt,
          bytes,
          libraryCount: data.library.length,
          historyCount: data.history.length,
          valid: true,
        };
      } catch (error) {
        const date = new Date(Number(name.split('-')[2]));
        return {
          name,
          createdAt: Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString(),
          bytes: 0,
          libraryCount: 0,
          historyCount: 0,
          valid: false,
          error: error instanceof AppError ? error.message : '备份无法读取',
        };
      }
    });
    return { directory: this.directory, items };
  }
}
