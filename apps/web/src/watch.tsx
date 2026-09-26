import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronRight,
  Expand,
  LoaderCircle,
  PictureInPicture2,
  Play,
  RefreshCw,
  Search,
  SkipForward,
} from 'lucide-react';
import Hls from 'hls.js';
import {
  episodeKey,
  refKey,
  type AnimeCard,
  type AppSettings,
  type Episode,
  type HistoryVersion,
  type LibraryEntry,
  type Playback,
  type SourceDetail,
  type SourceState,
  type SettingsPatch,
} from '../../../packages/core/src/types';
import {
  api,
  detailPath,
  isSessionError,
  post,
  preferSettings,
  putSettings,
  timeLabel,
  watchPath,
} from './api';
import { ErrorState, Loading, useToast } from './ui';
import { SourceRecovery } from './source-recovery';
import './player-recovery.css';
import { EpisodeBrowser } from './episode-browser';
import type { SwitchContext } from './pages';
import { matchingEpisode } from '../../../packages/core/src/matching';
import { completedEpisode, historyTime, progressForEpisode } from '../../../packages/core/src/progress';
import { useHistoryContext, useAnimeHistory, useProgressQueue, useProgressStatus } from './history';
import { DanmakuLayer } from './danmaku-layer';
import { PlaybackSocialControls, usePlaybackSocial } from './watch-social';

const SEEK_STEP_SECONDS = 5;
const SPEED_HOLD_DELAY_MS = 350;

interface PlayerHandle {
  position(): number;
  pause(): void;
}
interface PlayerProps {
  card: AnimeCard;
  episode: Episode;
  resume: number;
  version: HistoryVersion;
  onReady: () => void;
  recovery: ReactNode;
  settings: AppSettings;
  onNext?: () => void;
  onPosition: (position: number) => void;
  onSettings: (patch: SettingsPatch) => void;
}
const VideoPlayer = forwardRef<PlayerHandle, PlayerProps>(function VideoPlayer(
  {
    card,
    episode,
    resume,
    version: initialVersion,
    onReady,
    recovery,
    settings,
    onNext,
    onPosition,
    onSettings,
  },
  ref,
) {
  const queue = useProgressQueue();
  const version = useRef(initialVersion).current;
  const saveStatus = useProgressStatus(episodeKey(episode.locator), version, card);
  const lastCapture = useRef(0);
  const lastSample = useRef('');
  const completionOverride = useRef<boolean | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const playback = useRef<Playback>(undefined);
  const hls = useRef<Hls>(undefined);
  const refreshing = useRef(false);
  const closed = useRef(false);
  const latest = useRef({ resume, settings, onNext, onPosition, onSettings, onReady });
  latest.current = { resume, settings, onNext, onPosition, onSettings, onReady };
  const [phase, setPhase] = useState<'resolving' | 'buffering' | 'playing' | 'paused' | 'error'>('resolving');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activePlayback, setActivePlayback] = useState<Playback>();
  const [playerReady, setPlayerReady] = useState(false);
  const social = usePlaybackSocial({ playback: activePlayback, settings, ready: playerReady });
  const restoreAt = useRef(resume);
  const hasMetadata = useRef(false);
  const rateBeforeBoost = useRef<number | null>(null);
  const flush = useCallback(
    (beacon = false) => {
      const element = video.current;
      if (!element || !hasMetadata.current || !Number.isFinite(element.duration) || element.duration <= 0)
        return;
      const position = element.currentTime;
      const completed = completionOverride.current ?? (element.ended || element.duration - position <= 0.5);
      const sample = JSON.stringify([position, element.duration, completed]);
      // Retries belong to the queue. An unchanged paused player must not become the latest viewing.
      if (sample === lastSample.current) return;
      lastCapture.current = Math.max(Date.now(), lastCapture.current + 1);
      const capturedAt = new Date(lastCapture.current).toISOString();
      const body = {
        card,
        episode,
        position,
        duration: element.duration,
        capturedAt,
        version,
        completed,
      };
      if (!queue.enqueue(body)) return;
      lastSample.current = sample;
      // Keep the durable outbox until an acknowledged save, even when sendBeacon is accepted.
      if (beacon)
        navigator.sendBeacon(
          '/api/v1/history',
          new Blob([JSON.stringify(body)], { type: 'application/json' }),
        );
      else void queue.flush();
    },
    [card, episode, queue, version],
  );
  useImperativeHandle(
    ref,
    () => ({
      position: () =>
        hasMetadata.current ? (video.current?.currentTime ?? restoreAt.current) : restoreAt.current,
      pause: () => video.current?.pause(),
    }),
    [],
  );
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void container.current?.requestFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    if (saveStatus.phase === 'changed' || (saveStatus.phase === 'failed' && !saveStatus.durable))
      video.current?.pause();
  }, [saveStatus]);

  useEffect(() => {
    const element = video.current!;
    const controller = new AbortController();
    closed.current = false;
    refreshing.current = false;
    hasMetadata.current = false;
    setActivePlayback(undefined);
    setPlayerReady(false);
    setPhase('resolving');
    setError('');
    const fail = (message: string) => {
      if (!closed.current) {
        setError(message);
        setPhase('error');
      }
    };
    const attach = (session: Playback) => {
      if (controller.signal.aborted) return;
      playback.current = session;
      setActivePlayback(session);
      setPlayerReady(false);
      hasMetadata.current = false;
      hls.current?.destroy();
      hls.current = undefined;
      setPhase('buffering');
      const nativeHls = Boolean(element.canPlayType('application/vnd.apple.mpegurl'));
      const safari =
        /Safari\//.test(navigator.userAgent) &&
        !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(navigator.userAgent);
      const useNativeHls = nativeHls && (safari || !Hls.isSupported());
      if (session.format === 'hls' && !useNativeHls) {
        if (!Hls.isSupported()) {
          fail('当前浏览器不支持这条 HLS 线路，请换用 Chrome 或其他线路');
          return;
        }
        const player = new Hls({ maxBufferLength: 30, backBufferLength: 30, maxMaxBufferLength: 60 });
        hls.current = player;
        player.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) void recover();
          else fail('这条线路的媒体格式无法解码，请尝试其他线路');
        });
        player.loadSource(session.url);
        player.attachMedia(element);
      } else {
        element.src = session.url;
        element.load();
      }
    };
    const recover = async () => {
      if (controller.signal.aborted || refreshing.current) return;
      const current = playback.current;
      if (!current || current.refreshed) {
        fail('刷新地址后仍无法播放，请尝试换线路或换源');
        return;
      }
      refreshing.current = true;
      if (hasMetadata.current) restoreAt.current = element.currentTime;
      setPhase('resolving');
      try {
        const next = await api<Playback>(`/playbacks/${current.sessionId}/refresh`, {
          method: 'POST',
          signal: controller.signal,
        });
        attach(next);
      } catch (error) {
        if (!controller.signal.aborted) fail(error instanceof Error ? error.message : '播放地址刷新失败');
      } finally {
        refreshing.current = false;
      }
    };
    const ready = () => {
      hasMetadata.current = true;
      setPlayerReady(true);
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      const saved = restoreAt.current;
      if (saved > 0 && Number.isFinite(element.duration))
        element.currentTime = Math.min(saved, Math.max(0, element.duration - 1));
      element.playbackRate = rateBeforeBoost.current === null ? latest.current.settings.playbackRate : 2;
      element.volume = latest.current.settings.volume;
      latest.current.onReady();
      void element.play().catch(() => setPhase('paused'));
    };
    const progress = () => {
      setPosition(element.currentTime);
      latest.current.onPosition(element.currentTime);
    };
    const pause = () => {
      if (hasMetadata.current) {
        setPhase((current) => (current === 'error' ? current : 'paused'));
        flush();
      }
    };
    const playing = () => {
      if (queue.status(episodeKey(episode.locator), version, card).phase === 'changed') {
        element.pause();
        return;
      }
      completionOverride.current = undefined;
      setPhase('playing');
    };
    const waiting = () => {
      if (!element.paused) setPhase('buffering');
    };
    const ended = () => {
      flush();
      if (latest.current.settings.autoNext) latest.current.onNext?.();
    };
    const mediaError = () => {
      if (!controller.signal.aborted) void recover();
    };
    const unload = () => flush(true);
    const volumeChanged = () => {
      if (hasMetadata.current && Math.abs(element.volume - latest.current.settings.volume) > 0.001)
        latest.current.onSettings({ volume: element.volume });
    };
    element.addEventListener('loadedmetadata', ready);
    element.addEventListener('timeupdate', progress);
    element.addEventListener('pause', pause);
    element.addEventListener('playing', playing);
    element.addEventListener('waiting', waiting);
    element.addEventListener('ended', ended);
    element.addEventListener('error', mediaError);
    window.addEventListener('pagehide', unload);
    element.addEventListener('volumechange', volumeChanged);
    const timer = setInterval(() => flush(), 5000);
    void api<Playback>('/playbacks', {
      method: 'POST',
      body: JSON.stringify(episode.locator),
      signal: controller.signal,
    })
      .then(attach)
      .catch((error) => {
        if (!controller.signal.aborted) fail(error instanceof Error ? error.message : '播放解析失败');
      });
    return () => {
      flush(true);
      closed.current = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('pagehide', unload);
      element.removeEventListener('volumechange', volumeChanged);
      element.removeEventListener('loadedmetadata', ready);
      element.removeEventListener('timeupdate', progress);
      element.removeEventListener('pause', pause);
      element.removeEventListener('playing', playing);
      element.removeEventListener('waiting', waiting);
      element.removeEventListener('ended', ended);
      element.removeEventListener('error', mediaError);
      hls.current?.destroy();
      hls.current = undefined;
      const current = playback.current;
      playback.current = undefined;
      if (current)
        void api(`/playbacks/${current.sessionId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
      element.removeAttribute('src');
      element.load();
    };
    // A new locator remounts this component; settings and callbacks are read through latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  useEffect(() => {
    if (rateBeforeBoost.current !== null) rateBeforeBoost.current = settings.playbackRate;
    else if (video.current) video.current.playbackRate = settings.playbackRate;
  }, [settings.playbackRate]);
  useEffect(() => {
    if (video.current) video.current.volume = settings.volume;
  }, [settings.volume]);
  useEffect(() => {
    const element = video.current!;
    let rightHeld = false;
    let longPress = false;
    let pressedAt = 0;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const isControl = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        Boolean(
          target.closest(
            'input,textarea,select,button,summary,a,[role="textbox"],[role="combobox"],[role="slider"],[role="spinbutton"],[role="menu"],[role="dialog"]',
          ),
        ));
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = undefined;
      rightHeld = false;
      longPress = false;
      if (rateBeforeBoost.current !== null) {
        element.playbackRate = rateBeforeBoost.current;
        rateBeforeBoost.current = null;
      }
    };
    const seek = (seconds: number) => {
      if (!hasMetadata.current || element.readyState < 1) return;
      const end = Number.isFinite(element.duration) ? element.duration : Infinity;
      element.currentTime = Math.max(0, Math.min(end, element.currentTime + seconds));
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isControl(event.target)
      ) {
        cancelHold();
        return;
      }
      const key = event.key.toLowerCase();
      if (!['arrowright', 'arrowleft', 'f', 'm'].includes(key) && event.code !== 'Space') return;
      // Capture before native video controls so one press cannot seek twice.
      event.preventDefault();
      if (event.repeat) return;
      if (key === 'arrowright') {
        if (rightHeld || !hasMetadata.current) return;
        rightHeld = true;
        longPress = false;
        pressedAt = performance.now();
        holdTimer = setTimeout(() => {
          holdTimer = undefined;
          longPress = true;
          if (!hasMetadata.current || element.paused || element.ended) return;
          rateBeforeBoost.current = element.playbackRate;
          element.playbackRate = 2;
        }, SPEED_HOLD_DELAY_MS);
      } else if (key === 'arrowleft') {
        cancelHold();
        seek(-SEEK_STEP_SECONDS);
      } else if (event.code === 'Space') {
        if (element.paused) void element.play().catch(() => {});
        else element.pause();
      } else if (key === 'f') fullscreen();
      else if (key === 'm') element.muted = !element.muted;
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowRight' || !rightHeld) return;
      event.preventDefault();
      const tap = !longPress && performance.now() - pressedAt < SPEED_HOLD_DELAY_MS;
      cancelHold();
      if (tap && !isControl(event.target)) seek(SEEK_STEP_SECONDS);
    };
    const focusChanged = (event: FocusEvent) => {
      if (isControl(event.target)) cancelHold();
    };
    const visibilityChanged = () => {
      if (document.hidden) cancelHold();
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', cancelHold);
    window.addEventListener('pagehide', cancelHold);
    document.addEventListener('focusin', focusChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    const resetEvents = ['pause', 'ended', 'emptied', 'error'] as const;
    for (const event of resetEvents) element.addEventListener(event, cancelHold);
    return () => {
      cancelHold();
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', cancelHold);
      window.removeEventListener('pagehide', cancelHold);
      document.removeEventListener('focusin', focusChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
      for (const event of resetEvents) element.removeEventListener(event, cancelHold);
    };
  }, [reload]);
  return (
    <div
      className={`player-container ${typeof document.documentElement.requestFullscreen === 'function' ? 'custom-fullscreen' : ''}`}
      ref={container}
    >
      <div className="video-stage">
        <video
          ref={video}
          controls
          playsInline
          preload="metadata"
          poster={card.imageUrl}
          aria-label={`${card.title} ${episode.label}`}
          aria-describedby="player-shortcuts"
        />
        <DanmakuLayer
          videoRef={video}
          comments={social.comments}
          enabled={social.enabled && phase !== 'error' && phase !== 'resolving'}
          opacity={settings.danmaku?.opacity ?? 0.85}
          fontScale={settings.danmaku?.fontScale ?? 1}
        />
        {(phase === 'resolving' || phase === 'buffering') && (
          <div className="player-overlay loading-overlay" role="status">
            <LoaderCircle size={32} className="spin" />
            <span>{phase === 'resolving' ? '正在获取播放地址' : '正在缓冲'}</span>
          </div>
        )}
        {phase === 'paused' && position === 0 && (
          <button
            className="big-play"
            aria-label="播放视频"
            onClick={() => {
              void video.current?.play();
            }}
          >
            <Play size={32} fill="currentColor" />
          </button>
        )}
        {phase === 'error' && (
          <div className="player-overlay player-error" role="alert">
            <FilmFallback />
            <h3>这一线路暂时无法播放</h3>
            <p>{error}</p>
            <button
              className="button secondary"
              onClick={() => {
                if (hasMetadata.current) restoreAt.current = video.current?.currentTime ?? restoreAt.current;
                setReload((n) => n + 1);
              }}
            >
              <RefreshCw size={16} />
              重新尝试
            </button>
            <div className="player-recovery-actions">{recovery}</div>
          </div>
        )}
      </div>
      <div className="player-toolbar">
        <span className="player-clock">
          {timeLabel(position)} <span>/ {timeLabel(duration)}</span>
        </span>
        <div className="player-tools">
          <select
            aria-label="播放速度"
            value={settings.playbackRate}
            onChange={(event) => onSettings({ playbackRate: Number(event.target.value) })}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((value) => (
              <option key={value} value={value}>
                {value === 1 ? '正常速度' : `${value}×`}
              </option>
            ))}
          </select>
          <details className="player-extra">
            <summary aria-label="更多播放选项">更多</summary>
            <button
              className="icon-button"
              aria-label="画中画"
              disabled={!document.pictureInPictureEnabled}
              onClick={() => {
                const element = video.current;
                if (document.pictureInPictureElement) void document.exitPictureInPicture();
                else if (element?.readyState) void element.requestPictureInPicture().catch(() => {});
              }}
            >
              <PictureInPicture2 size={19} />
            </button>
          </details>
          <button className="icon-button" aria-label="全屏" onClick={fullscreen}>
            <Expand size={19} />
          </button>
          {onNext && (
            <button className="icon-button" aria-label="下一集" onClick={onNext}>
              <SkipForward size={19} />
            </button>
          )}
        </div>
      </div>
      <PlaybackSocialControls social={social} settings={settings} onSettings={onSettings} />
      <div className={`progress-save-status ${saveStatus.phase}`} role="status">
        {saveStatus.phase === 'changed' ? (
          <>
            <span>{saveStatus.message}</span>
            <button className="text-link" onClick={() => window.location.reload()}>
              重新读取进度
            </button>
          </>
        ) : saveStatus.phase === 'failed' ? (
          <>
            <span>
              {saveStatus.durable
                ? '进度暂未保存，已保留在本机等待重试。请在当前页面完成重试后再退出。'
                : '进度暂未保存，只保留在当前窗口，请暂勿关闭。'}{' '}
              {saveStatus.message}
            </span>
            <button className="text-link" onClick={() => void queue.flush()}>
              重试保存
            </button>
          </>
        ) : saveStatus.phase === 'pending' ? (
          <span>{saveStatus.durable ? '进度待保存' : '正在保存进度'}</span>
        ) : (
          <span>进度自动保存</span>
        )}
        <button
          className="text-link"
          disabled={!duration || saveStatus.phase === 'changed'}
          onClick={() => {
            completionOverride.current = true;
            video.current?.pause();
            flush();
          }}
        >
          标记本集已看完
        </button>
      </div>
    </div>
  );
});
const FilmFallback = () => <Play size={32} strokeWidth={1.2} />;

export default function WatchPage() {
  const { sourceId = '', id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['detail', sourceId, id],
    queryFn: ({ signal }) =>
      api<SourceDetail>(`/sources/${sourceId}/detail?itemId=${encodeURIComponent(id)}`, { signal }),
  });
  const library = useQuery({ queryKey: ['library'], queryFn: () => api<LibraryEntry[]>('/library') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/settings') });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api<SourceState[]>('/sources') });
  const animeHistory = useAnimeHistory({ sourceId, id }, library.data);
  const player = useRef<PlayerHandle>(null);
  const currentPosition = useRef(0);
  const [extraLines, setExtraLines] = useState<{ id: string; name: string }[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);
  const line = query.data?.lines.find((l) => l.id === params.get('line')) ?? query.data?.lines[0];
  const rawEpisode = line?.episodes.find((e) => e.id === params.get('episode')) ?? line?.episodes[0];
  const episode =
    rawEpisode && sourceId === 'anich' && params.get('line')
      ? { ...rawEpisode, locator: { ...rawEpisode.locator, lineId: params.get('line')! } }
      : rawEpisode;
  const historyEntry = useHistoryContext(episode?.locator);
  const entry = library.data?.find((e) => e.refs.some((r) => r.sourceId === sourceId && r.id === id));
  const candidates = [
    ...(animeHistory.data ?? []),
    ...(historyEntry.data?.entry ? [historyEntry.data.entry] : []),
  ].sort((a, b) => historyTime(b) - historyTime(a));
  const saved = episode && line ? progressForEpisode(episode, line, candidates) : historyEntry.data?.entry;
  const requestedResume = params.has('resume') ? Number(params.get('resume')) : undefined;
  const resume =
    requestedResume !== undefined && Number.isFinite(requestedResume) && requestedResume >= 0
      ? requestedResume
      : saved && !completedEpisode(saved)
        ? saved.position
        : 0;
  const next = rawEpisode && line?.episodes[line.episodes.findIndex((e) => e.id === rawEpisode.id) + 1];
  useEffect(() => {
    setExtraLines([]);
  }, [sourceId, id, episode?.id]);
  const updateSettings = (patch: SettingsPatch) => {
    const current = client.getQueryData<AppSettings>(['settings']) ??
      settings.data ?? { autoNext: true, volume: 0.8, playbackRate: 1 };
    void putSettings(current, patch)
      .then((saved) => {
        client.setQueryData<AppSettings>(['settings'], (latest) => preferSettings(latest, saved));
      })
      .catch((error) => toast(error instanceof Error ? error.message : '设置未能保存'));
  };
  const changeLine = (lineId: string) => {
    if (!episode) return;
    const target = query.data?.lines.find((l) => l.id === lineId);
    const matching = target && matchingEpisode(episode, target.episodes);
    if (sourceId === 'anich')
      navigate(watchPath(sourceId, id, lineId, episode.id, player.current?.position() ?? 0));
    else if (matching)
      navigate(watchPath(sourceId, id, lineId, matching.id, player.current?.position() ?? 0));
    else if (target) {
      toast('集数无法自动对应，请在详情页手动选择');
      navigate(detailPath(sourceId, id), { state: { preferredLine: lineId } });
    }
  };
  const otherSources = () => {
    if (!episode || !query.data) return;
    player.current?.pause();
    const switchContext: SwitchContext = {
      card: query.data,
      episode,
      position: player.current?.position() ?? currentPosition.current,
    };
    const alternative = sources.data?.find(
      (source) => source.id !== sourceId && source.enabled && source.capabilities.includes('search'),
    );
    navigate(
      '/search?' +
        new URLSearchParams({ q: query.data.title, ...(alternative ? { source: alternative.id } : {}) }),
      { state: { switchContext } },
    );
  };
  const favorite = async () => {
    if (!query.data) return;
    try {
      if (!entry) {
        await post('/library', { card: query.data, status: 'watching' });
        await client.invalidateQueries({ queryKey: ['library'] });
        toast('已加入我的番剧');
      } else navigate('/library');
    } catch (error) {
      toast(error instanceof Error ? error.message : '追番失败');
    }
  };
  const getLines = async () => {
    if (!episode) return;
    setLoadingLines(true);
    try {
      setExtraLines(await post('/playback-lines', episode.locator));
    } catch (error) {
      toast(error instanceof Error ? error.message : '无法读取线路');
    } finally {
      setLoadingLines(false);
    }
  };
  if (query.isPending || library.isPending || (episode && (historyEntry.isPending || animeHistory.isPending)))
    return <Loading label="正在准备播放器…" />;
  if (query.isError || !query.data || !episode)
    return (
      <SourceRecovery
        sourceId={sourceId}
        id={id}
        error={query.error ?? new Error('这个来源暂时没有可播放剧集')}
        retry={() => void query.refetch()}
      />
    );
  if (historyEntry.isError || animeHistory.isError)
    return (
      <ErrorState
        error={
          isSessionError(historyEntry.error ?? animeHistory.error)
            ? (historyEntry.error ?? animeHistory.error)
            : new Error('未能读取观看进度，请重试后继续播放')
        }
        retry={() => {
          void historyEntry.refetch();
          void animeHistory.refetch();
        }}
      />
    );
  const data = query.data;
  const currentSettings = settings.data ?? { autoNext: true, volume: 0.8, playbackRate: 1 };
  return (
    <>
      <div className="watch-heading">
        <Link className="back-link" to={detailPath(sourceId, id)}>
          <ArrowLeft size={17} />
          番剧详情
        </Link>
        <div>
          <h1>{data.title}</h1>
          <p>{episode.label}</p>
        </div>
        <button
          className="button secondary small"
          onClick={() => {
            void favorite();
          }}
        >
          {entry ? <Check size={16} /> : <Bookmark size={16} />} {entry ? '我的番剧' : '追番'}
        </button>
      </div>
      <div className="watch-layout">
        <div className="watch-main">
          <VideoPlayer
            key={episodeKey(episode.locator)}
            ref={player}
            card={data}
            episode={episode}
            resume={resume}
            version={historyEntry.data!.version}
            onReady={() => {
              if (!params.has('resume')) return;
              const consumed = new URLSearchParams(params);
              consumed.delete('resume');
              setParams(consumed, { replace: true });
            }}
            recovery={
              <>
                {data.lines.length > 1 && (
                  <label>
                    切换线路
                    <select
                      aria-label="错误恢复线路"
                      value={episode.locator.lineId}
                      onChange={(event) => changeLine(event.target.value)}
                    >
                      {data.lines.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {entry?.refs
                  .filter((ref) => ref.sourceId !== sourceId || ref.id !== id)
                  .map((ref) => (
                    <button
                      key={refKey(ref)}
                      className="button secondary small"
                      onClick={() => {
                        const position = player.current?.position() ?? resume;
                        player.current?.pause();
                        navigate(detailPath(ref.sourceId, ref.id), {
                          state: { switchContext: { card: data, episode, position } },
                        });
                      }}
                    >
                      已关联 ·{' '}
                      {sources.data?.find((source) => source.id === ref.sourceId)?.name ?? ref.sourceId}
                    </button>
                  ))}
                <button className="button secondary small" onClick={otherSources}>
                  查找其他来源
                </button>
                <Link className="button secondary small" to="/settings">
                  管理来源
                </Link>
              </>
            }
            settings={currentSettings}
            onSettings={updateSettings}
            onPosition={(position) => {
              currentPosition.current = position;
            }}
            onNext={
              next ? () => navigate(watchPath(sourceId, id, episode.locator.lineId, next.id, 0)) : undefined
            }
          />
          <div className="watch-footnote" id="player-shortcuts">
            <span>空格 暂停 / 播放</span>
            <span>← → 快退 / 快进 5 秒</span>
            <span>F 全屏</span>
          </div>
          <div className="setting-row compact">
            <span>自动播放下一集</span>
            <button
              className={currentSettings.autoNext ? 'toggle on' : 'toggle'}
              role="switch"
              aria-checked={currentSettings.autoNext}
              aria-label="自动播放下一集"
              onClick={() => updateSettings({ autoNext: !currentSettings.autoNext })}
            >
              <span />
            </button>
          </div>
          {!!entry && entry.refs.length > 1 && (
            <div className="linked-source-links">
              <span>已关联来源</span>
              {entry.refs
                .filter((ref) => ref.sourceId !== sourceId)
                .map((ref) => (
                  <button
                    key={refKey(ref)}
                    className="chip"
                    onClick={() => {
                      const position = player.current?.position() ?? currentPosition.current;
                      player.current?.pause();
                      navigate(detailPath(ref.sourceId, ref.id), {
                        state: { switchContext: { card: data, episode, position } },
                      });
                    }}
                  >
                    {sources.data?.find((s) => s.id === ref.sourceId)?.name ?? ref.sourceId}
                    <ChevronRight size={14} />
                  </button>
                ))}
            </div>
          )}
        </div>
        <aside className="episode-panel">
          <div className="panel-heading">
            <h2>选集</h2>
            <small>{line?.episodes.length ?? 0} 话</small>
          </div>
          <label className="line-select">
            <span>播放线路</span>
            <select
              aria-label="播放线路"
              value={episode.locator.lineId}
              onChange={(event) => changeLine(event.target.value)}
            >
              {data.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
              {extraLines
                .filter((l) => !data.lines.some((d) => d.id === l.id))
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
          </label>
          {sourceId === 'anich' && (
            <button
              className="text-link line-refresh"
              disabled={loadingLines}
              onClick={() => {
                void getLines();
              }}
            >
              {loadingLines ? '正在读取…' : '查看这集的其他线路'}
            </button>
          )}
          {line && (
            <EpisodeBrowser
              line={line}
              history={animeHistory.data ?? []}
              currentEpisodeId={episode.id}
              compact
              episodeHref={(ep) => watchPath(sourceId, id, episode.locator.lineId, ep.id)}
            />
          )}
          <button className="button secondary wide switch-source" onClick={otherSources}>
            <Search size={16} />
            查找其他来源
          </button>
        </aside>
      </div>
    </>
  );
}
