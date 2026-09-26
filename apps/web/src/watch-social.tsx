import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, MessageSquare, RefreshCw, Users } from 'lucide-react';
import type {
  AppSettings,
  AudienceSnapshot,
  DanmakuComment,
  DanmakuFeed,
  DanmakuSettings,
  Playback,
  SettingsPatch,
} from '../../../packages/core/src/types';
import { api } from './api';
import { clampDanmakuNumber } from './danmaku-layout';
import './watch-social.css';

const EMPTY_COMMENTS: DanmakuComment[] = [];
const HEARTBEAT_MS = 30_000;
const defaultDanmaku: DanmakuSettings = { enabled: false, opacity: 0.85, fontScale: 1 };

export type PlaybackAudienceState =
  | { phase: 'unsupported' | 'waiting' | 'joining' }
  | { phase: 'ready'; snapshot: AudienceSnapshot }
  | { phase: 'unavailable' | 'closed'; message: string };

export interface PlaybackSocial {
  sourceLabel: string;
  danmakuSupported: boolean;
  audienceSupported: boolean;
  enabled: boolean;
  comments: DanmakuComment[];
  feed?: DanmakuFeed;
  danmakuPhase: 'waiting' | 'unsupported' | 'off' | 'loading' | 'ready' | 'empty' | 'error';
  danmakuError?: string;
  danmakuFetching: boolean;
  retryDanmaku(): void;
  audience: PlaybackAudienceState;
}

function preferences(settings: AppSettings): DanmakuSettings {
  const saved = settings.danmaku ?? defaultDanmaku;
  return {
    enabled: saved.enabled === true,
    opacity: clampDanmakuNumber(saved.opacity, 0.25, 1, 0.85),
    fontScale: clampDanmakuNumber(saved.fontScale, 0.75, 1.5, 1),
  };
}

function audienceSnapshot(value: AudienceSnapshot): AudienceSnapshot {
  if (
    !value ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    value.scope !== 'episode-line' ||
    !Number.isFinite(Date.parse(value.sampledAt))
  )
    throw new Error('来源暂未返回有效的观看人数');
  return value;
}

/** Close is idempotent on the engine, including a close that precedes the first open ACK. */
function closeAudience(path: string, beacon = false) {
  const url = `/api/v1${path}/close`;
  if (beacon && typeof navigator.sendBeacon === 'function') {
    try {
      if (navigator.sendBeacon(url)) return;
    } catch {
      // A keepalive request also covers environments that reject sendBeacon.
    }
  }
  void fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {});
}

export function usePlaybackSocial({
  playback,
  settings,
  ready,
}: {
  playback?: Playback;
  settings: AppSettings;
  ready: boolean;
}): PlaybackSocial {
  const sessionId = playback?.sessionId;
  const danmakuSupported = playback?.features?.includes('danmaku') ?? false;
  const audienceSupported = playback?.features?.includes('audience') ?? false;
  const enabled = danmakuSupported && preferences(settings).enabled;
  const queryClient = useQueryClient();
  const refreshed = playback?.refreshed ?? false;
  const refreshKey = `${sessionId}:${refreshed}`;
  const refreshRequests = useRef(new Set<string>());
  const query = useQuery({
    queryKey: ['playback-danmaku', sessionId, refreshed],
    queryFn: ({ signal }) => {
      const fresh = refreshRequests.current.delete(refreshKey);
      return api<DanmakuFeed>(
        `/playbacks/${encodeURIComponent(sessionId!)}/danmaku${fresh ? '?refresh=1' : ''}`,
        { signal },
      );
    },
    enabled: Boolean(sessionId && enabled),
    retry: false,
    staleTime: Infinity,
    // Session URLs are never reused; only the engine keeps a bounded cross-session cache.
    gcTime: 0,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (sessionId && !enabled)
      void queryClient.cancelQueries({ queryKey: ['playback-danmaku', sessionId, refreshed], exact: true });
  }, [enabled, queryClient, refreshed, sessionId]);

  const readyRef = useRef(ready);
  readyRef.current = ready;
  const onReady = useRef<(() => void) | undefined>(undefined);
  const [audience, setAudience] = useState<{ sessionId?: string; value: PlaybackAudienceState }>({
    value: { phase: 'waiting' },
  });

  useEffect(() => {
    onReady.current?.();
  }, [ready]);

  useEffect(() => {
    if (!sessionId || !audienceSupported) {
      setAudience({ sessionId, value: { phase: sessionId ? 'unsupported' : 'waiting' } });
      return;
    }
    const path = `/playbacks/${encodeURIComponent(sessionId)}/audience`;
    let mounted = true;
    let closed = false;
    let started = false;
    let pending = false;
    let startTimer: number | undefined;
    let heartbeat: number | undefined;
    let snapshot: AudienceSnapshot | undefined;
    const publish = (value: PlaybackAudienceState) => {
      if (mounted) setAudience({ sessionId, value });
    };
    publish({ phase: 'waiting' });
    const cancelTimers = () => {
      if (startTimer !== undefined) window.clearTimeout(startTimer);
      if (heartbeat !== undefined) window.clearTimeout(heartbeat);
      startTimer = undefined;
      heartbeat = undefined;
    };
    const close = (beacon = false) => {
      closed = true;
      cancelTimers();
      if (started) closeAudience(path, beacon);
    };
    const send = async () => {
      if (!mounted || closed || pending) return;
      pending = true;
      started = true;
      if (!snapshot) publish({ phase: 'joining' });
      try {
        const received = audienceSnapshot(await api<AudienceSnapshot>(path, { method: 'POST' }));
        if (!mounted || closed) {
          // A slow first response must not leave a presence behind after navigation.
          closeAudience(path);
          return;
        }
        // Heartbeats keep the local lease alive. They do not sample upstream again.
        snapshot ??= received;
        publish({ phase: 'ready', snapshot });
        heartbeat = window.setTimeout(() => void send(), HEARTBEAT_MS);
      } catch (error) {
        if (!mounted || closed) return;
        close();
        publish({
          phase: 'unavailable',
          message: error instanceof Error ? error.message : '观看人数暂不可用',
        });
      } finally {
        pending = false;
      }
    };
    const start = () => {
      if (!mounted || closed || started || startTimer !== undefined || !readyRef.current || document.hidden)
        return;
      // React StrictMode replays effects before this task runs. Never create a lease
      // during that discarded setup, whose cleanup would immediately close it.
      startTimer = window.setTimeout(() => {
        startTimer = undefined;
        if (readyRef.current && !document.hidden) void send();
      }, 0);
    };
    const visibility = () => {
      if (document.hidden || closed) return;
      if (!started) start();
      else if (!pending) {
        if (heartbeat !== undefined) window.clearTimeout(heartbeat);
        heartbeat = undefined;
        void send();
      }
    };
    const pagehide = () => {
      close(true);
      publish({ phase: 'closed', message: '已停止人数登记；重新打开播放可重新读取。' });
    };
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted && closed)
        publish({ phase: 'closed', message: '页面已恢复，人数登记已结束；重新打开播放可重新读取。' });
    };
    onReady.current = start;
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    start();
    return () => {
      mounted = false;
      close();
      if (onReady.current === start) onReady.current = undefined;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
    };
  }, [audienceSupported, sessionId]);

  const audienceState =
    audience.sessionId === sessionId
      ? audience.value
      : { phase: sessionId && !audienceSupported ? ('unsupported' as const) : ('waiting' as const) };
  return {
    sourceLabel: playback?.locator.sourceId === 'girigiri' ? 'girigiri' : '来源',
    danmakuSupported,
    audienceSupported,
    enabled,
    comments: enabled ? (query.data?.comments ?? EMPTY_COMMENTS) : EMPTY_COMMENTS,
    feed: enabled ? query.data : undefined,
    danmakuPhase: !sessionId
      ? 'waiting'
      : !danmakuSupported
        ? 'unsupported'
        : !enabled
          ? 'off'
          : query.isError
            ? 'error'
            : query.isPending
              ? 'loading'
              : query.data.comments.length
                ? 'ready'
                : 'empty',
    danmakuError: query.error instanceof Error ? query.error.message : undefined,
    danmakuFetching: enabled && query.isFetching,
    retryDanmaku: () => {
      if (sessionId && enabled && !query.isFetching) {
        refreshRequests.current.add(refreshKey);
        void query.refetch();
      }
    },
    audience: audienceState,
  };
}

function AudienceStatus({ social }: { social: PlaybackSocial }) {
  const state = social.audience;
  if (!social.audienceSupported) return null;
  const explanation =
    '这是进入本集、本线路时的来源人数，不会随播放持续刷新；不同线路的人数可能不同。';
  const sampled = state.phase === 'ready' ? new Date(state.snapshot.sampledAt).toLocaleString('zh-CN') : '';
  const label =
    state.phase === 'ready'
      ? `${social.sourceLabel} · 本线路 ${state.snapshot.count.toLocaleString('zh-CN')} 人在看（进入时）`
      : state.phase === 'waiting'
        ? `${social.sourceLabel} · 播放就绪后读取人数`
        : state.phase === 'joining'
          ? `${social.sourceLabel} · 正在读取观看人数`
          : state.phase === 'closed'
            ? `${social.sourceLabel} · 人数登记已结束`
            : `${social.sourceLabel} · 人数暂不可用`;
  const description =
    state.phase === 'ready'
      ? `${explanation} 采样时间：${sampled}。`
      : state.phase === 'unavailable' || state.phase === 'closed'
        ? `${state.message} ${explanation}`
        : explanation;
  return (
    <span
      className="watch-social-audience"
      role="status"
      title={description}
      aria-label={`${label}。${description}`}
    >
      <Users size={16} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function PlaybackSocialControls({
  social,
  settings,
  onSettings,
}: {
  social: PlaybackSocial;
  settings: AppSettings;
  onSettings: (patch: SettingsPatch) => void;
}) {
  const saved = preferences(settings);
  const update = (patch: Partial<DanmakuSettings>) => onSettings({ danmaku: patch });
  const opacity = Math.round(saved.opacity * 100);
  const fontScale = Math.round(saved.fontScale * 100);
  const opacityOptions = [...new Set([25, 50, 65, 85, 100, opacity])].sort((a, b) => a - b);
  const fontOptions = [...new Set([75, 100, 125, 150, fontScale])].sort((a, b) => a - b);
  const count = social.feed?.comments.length ?? 0;
  const status =
    social.danmakuPhase === 'loading'
      ? '正在读取弹幕…'
      : social.danmakuPhase === 'empty'
        ? '本集暂时没有弹幕'
        : social.danmakuPhase === 'error'
          ? count
            ? '弹幕更新失败，继续显示已读取的内容'
            : '弹幕暂时不可用'
          : social.danmakuPhase === 'ready'
            ? `已读取 ${count.toLocaleString('zh-CN')} 条弹幕`
            : social.danmakuPhase === 'unsupported'
              ? '当前来源未提供弹幕'
              : social.danmakuPhase === 'waiting'
                ? '播放地址就绪后可读取弹幕'
                : '';
  const canRetry = social.enabled && ['empty', 'error', 'ready'].includes(social.danmakuPhase);
  return (
    <div className="watch-social" aria-label="弹幕和观看人数">
      <div className="watch-social-main">
        <div className="watch-social-danmaku">
          <button
            type="button"
            className="watch-social-toggle"
            aria-label="弹幕"
            aria-pressed={social.enabled}
            disabled={!social.danmakuSupported}
            onClick={() => update({ enabled: !saved.enabled })}
          >
            <MessageSquare size={17} aria-hidden="true" />
            弹幕：{social.enabled ? '开' : '关'}
          </button>
          {status && (
            <span
              className={`watch-social-status ${social.danmakuPhase === 'error' ? 'error' : ''}`}
              role="status"
              title={social.danmakuError}
            >
              {social.danmakuFetching && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
              {status}
            </span>
          )}
          {canRetry && (
            <button
              type="button"
              className="watch-social-retry"
              disabled={social.danmakuFetching}
              onClick={social.retryDanmaku}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {social.danmakuPhase === 'ready' ? '刷新弹幕' : '重试弹幕'}
            </button>
          )}
        </div>
        <AudienceStatus social={social} />
      </div>
      {social.enabled && (
        <>
          {Boolean(social.feed?.warnings?.length) && (
            <p className="watch-social-warning" role="status">
              {social.feed!.warnings!.join(' ')}
            </p>
          )}
          {social.feed?.truncated && (
            <p className="watch-social-note">
              本集弹幕较多，已载入 {count.toLocaleString('zh-CN')} /{' '}
              {social.feed.total.toLocaleString('zh-CN')} 条；密集弹幕会自动避让。
            </p>
          )}
          <details className="watch-social-settings">
            <summary>弹幕设置</summary>
            <div className="watch-social-fields">
              <label>
                透明度
                <select
                  aria-label="弹幕透明度"
                  value={opacity}
                  onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
                >
                  {opacityOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}%
                    </option>
                  ))}
                </select>
              </label>
              <label>
                字号
                <select
                  aria-label="弹幕字号"
                  value={fontScale}
                  onChange={(event) => update({ fontScale: Number(event.target.value) / 100 })}
                >
                  {fontOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}%
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="watch-social-note">
              底部保留字幕空间。系统开启减少动态效果时，弹幕以固定方式显示。画中画无法叠加弹幕。
            </p>
          </details>
        </>
      )}
      {social.audience.phase === 'closed' && <p className="watch-social-note">{social.audience.message}</p>}
    </div>
  );
}
