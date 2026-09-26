export const APP_VERSION = '0.7.2';
/** Shared by export, restore and the settings page. Larger backups fail with an explicit error. */
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
export type MediaKind = 'tv' | 'movie' | 'ova' | 'special' | 'unknown';
export interface SourceRef {
  sourceId: string;
  id: string;
}
export interface AnimeCard extends SourceRef {
  title: string;
  poster?: string;
  imageUrl?: string;
  description?: string;
  year?: number;
  season?: number;
  kind: MediaKind;
  remarks?: string;
  aliases?: string[];
  externalIds?: Record<string, string>;
  ratings?: SourceRating[];
}
/** A source's own vote or a score copied by that source, never an official API response. */
export interface SourceRating {
  label: string;
  score: number;
  total?: number;
  origin: 'source' | 'bangumi-snapshot';
}
export interface BangumiSubject {
  id: string;
  title: string;
  originalTitle: string;
  aliases: string[];
  date?: string;
  year?: number;
  kind: MediaKind;
  platform: string;
  score?: number;
  total: number;
  rank?: number;
  fetchedAt: string;
}
export interface BangumiResult {
  status: 'matched' | 'ambiguous' | 'not-found';
  subject?: BangumiSubject;
  candidates: BangumiSubject[];
  match?: 'manual' | 'external-id' | 'exact';
}
export interface BangumiLink extends SourceRef {
  subjectId: string;
}
export interface EpisodeLocator {
  sourceId: string;
  animeId: string;
  lineId: string;
  episodeId: string;
}
export interface Episode {
  id: string;
  label: string;
  number: number | null;
  kind: 'episode' | 'special' | 'movie';
  locator: EpisodeLocator;
}
export interface PlayLine {
  id: string;
  name: string;
  episodes: Episode[];
}
export interface SourceDetail extends AnimeCard {
  lines: PlayLine[];
}
export interface HomeSection {
  title: string;
  items: AnimeCard[];
  description?: string;
  catalogFilters?: Record<string, string>;
}
export interface SearchInput {
  keyword: string;
  page: number;
  cursor?: string;
}
export interface SearchPage {
  items: AnimeCard[];
  page: number;
  hasMore: boolean;
  nextCursor?: string;
}
export interface CatalogFilter {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
}
export interface CatalogInput {
  page: number;
  filters: Record<string, string>;
  cursor?: string;
}
export interface CatalogPage extends SearchPage {
  total?: number;
  pageCount?: number;
}
export interface ScheduleDay {
  sourceId: string;
  weekday: number;
  items: AnimeCard[];
  checkedAt: string;
}
export interface SearchHistoryEntry {
  keyword: string;
  searchedAt: string;
}
export interface SourceManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  allowedHosts: string[];
  capabilities: (
    'search' | 'home' | 'play' | 'multiLine' | 'catalog' | 'schedule' | 'danmaku' | 'audience'
  )[];
  catalogFilters?: CatalogFilter[];
  catalogPagination?: 'page' | 'cursor';
}
export interface SourceState extends SourceManifest {
  enabled: boolean;
  priority: number;
  health: { status: 'unknown' | 'ok' | 'error'; checkedAt?: string; latency?: number; message?: string };
  verification: 'experimental' | 'verified';
}
export interface SearchChallenge {
  id: string;
  sourceId: string;
  imageUrl: string;
  expiresAt: string;
  message: string;
  digits: number;
}
export type SearchContinuation =
  | { type: 'result'; sourceId: string; page: SearchPage; cached: boolean }
  | { type: 'challenge'; sourceId: string; challenge: SearchChallenge };
export type SearchEvent =
  | { type: 'source'; sourceId: string; status: 'loading' }
  | SearchContinuation
  | { type: 'error'; sourceId: string; code: string; message: string }
  | { type: 'done' };
export type WatchStatus = 'planned' | 'watching' | 'completed' | 'paused';
export interface LibraryEpisode extends SourceRef {
  /** Stable within one source; equivalent numbered episodes on multiple lines share a key. */
  key: string;
  label: string;
  number: number | null;
  kind: Episode['kind'];
  locator: EpisodeLocator;
}
export interface SourceEpisodeSnapshot extends SourceRef {
  episodes: LibraryEpisode[];
  checkedAt: string;
}
export interface LibraryUpdate extends LibraryEpisode {
  addedAt: string;
}
export interface LibraryEntry {
  id: string;
  card: AnimeCard;
  refs: SourceRef[];
  status: WatchStatus;
  addedAt: string;
  updatedAt: string;
  latestCount: number;
  seenCount: number;
  checkedAt?: string;
  contentUpdatedAt?: string;
  updateError?: string;
  revision?: string;
  /** Changes when source membership changes, including unlinking and re-linking the same source. */
  associationRevision?: string;
  episodeSnapshots?: SourceEpisodeSnapshot[];
  /** Undefined preserves a legacy count-only reminder until a concrete baseline is available. */
  updates?: LibraryUpdate[];
  /** Older backups can retain count-only reminders alongside newly identified episodes. */
  unidentifiedUpdateCount?: number;
}
export interface LibraryCheckJob {
  id: string;
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt?: string;
  items: {
    id: string;
    title: string;
    status: 'pending' | 'checking' | 'success' | 'failed' | 'skipped';
    message?: string;
  }[];
}
export interface LibraryLinkPreview {
  token: string;
  expiresAt: string;
  base: LibraryEntry | null;
  merged: LibraryEntry[];
  refs: SourceRef[];
  status: WatchStatus;
  creates: boolean;
}
export interface BackupPreview {
  fingerprint: string;
  exportedAt: string;
  libraryCount: number;
  historyCount: number;
  searchHistoryCount: number;
  sourceCount: number;
  current: { libraryCount: number; historyCount: number };
  replace: string[];
}
export interface BackupFile {
  name: string;
  createdAt: string;
  libraryCount: number;
  historyCount: number;
  bytes: number;
  valid: boolean;
  error?: string;
}
export interface HistoryEntry {
  key: string;
  card: AnimeCard;
  episode: Episode;
  position: number;
  duration: number;
  /** When the player sampled this position. Older samples must not replace a newer one. */
  capturedAt?: string;
  updatedAt: string;
  /** Explicit completion takes precedence over the legacy end-of-media inference. */
  completed?: boolean;
}
/** Deletion/restore fences are deliberately not included in portable backups. */
export interface HistoryVersion {
  /** Local database identity. Portable backups never contain or replace it. */
  profile?: string;
  all: number;
  series: number;
  episode: number;
}
export interface HistoryWrite extends Omit<HistoryEntry, 'key' | 'updatedAt'> {
  capturedAt: string;
  version?: HistoryVersion;
}
export interface HistoryContext {
  entry: HistoryEntry | null;
  version: HistoryVersion;
}
export interface HistoryBoundary {
  /** Global generation in which a scoped deletion happened. */
  epoch?: number;
  all?: number;
  series?: (SourceRef & { version: number })[];
  episode?: { key: string; version: number };
}
export interface HistoryPage {
  items: HistoryEntry[];
  total: number;
  nextCursor?: string;
}
export type SourceModule = 'search' | 'home' | 'catalog' | 'schedule';
export interface DanmakuSettings {
  enabled: boolean;
  opacity: number;
  fontScale: number;
}
export interface DanmakuComment {
  id: string;
  /** Seconds on the video's timeline. */
  time: number;
  mode: 'scroll' | 'top' | 'bottom';
  color: string;
  text: string;
}
export interface DanmakuFeed {
  comments: DanmakuComment[];
  total: number;
  truncated: boolean;
  fetchedAt: string;
  warnings?: string[];
}
/** The source returns a snapshot on entry, not a live subscription. */
export interface AudienceSnapshot {
  count: number;
  scope: 'episode-line';
  sampledAt: string;
}
export interface AppSettings {
  /** Local profile generation. The server changes it on restore; portable backups omit it. */
  readonly generation?: string;
  autoNext: boolean;
  playbackRate: number;
  volume: number;
  appearance?: 'dark' | 'light' | 'system';
  danmaku?: DanmakuSettings;
  /** Stored with the profile, so launch-time port changes do not reset module choices. */
  sourcePreferences?: Partial<Record<SourceModule, string>>;
  /** Incremented on each successful save. Writers must send the revision they read. */
  revision?: number;
}
export interface Playback {
  sessionId: string;
  url: string;
  format: 'hls' | 'mp4' | 'auto';
  locator: EpisodeLocator;
  refreshed: boolean;
  features?: ('danmaku' | 'audience')[];
}
/** Nested preference edits rebase only the fields the user changed. */
export type SettingsPatch = Omit<Partial<AppSettings>, 'danmaku'> & { danmaku?: Partial<DanmakuSettings> };
export interface SearchGroup {
  id: string;
  title: string;
  items: AnimeCard[];
}
export const refKey = (ref: SourceRef) => `${ref.sourceId}:${ref.id}`;
export const episodeKey = (e: EpisodeLocator) => `${e.sourceId}:${e.animeId}:${e.lineId}:${e.episodeId}`;
export const statusLabels: Record<WatchStatus, string> = {
  planned: '想看',
  watching: '在看',
  completed: '看完',
  paused: '暂停',
};
