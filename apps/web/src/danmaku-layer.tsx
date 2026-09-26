import { useEffect, useRef, type RefObject } from 'react';
import {
  clampDanmakuNumber,
  createDanmakuLayout,
  danmakuViewport,
  nextDanmakuChange,
  sampleDanmaku,
  type DanmakuItem,
  type DanmakuLayout,
} from './danmaku-layout';
import './danmaku.css';

export interface DanmakuLayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  comments: DanmakuItem[];
  enabled: boolean;
  opacity: number;
  fontScale: number;
}

const font = (size: number) =>
  `600 ${size}px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;

/** Passive canvas overlay: comments are text only and never receive player input. */
export function DanmakuLayer({ videoRef, comments, enabled, opacity, fontScale }: DanmakuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const redraw = useRef<(() => void) | undefined>(undefined);
  const latestOpacity = useRef(opacity);
  latestOpacity.current = clampDanmakuNumber(opacity, 0.25, 1, 0.85);

  useEffect(() => {
    redraw.current?.();
  }, [opacity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !video || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!enabled || !comments.length) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let raf: number | undefined;
    let wakeup: number | undefined;
    let dirty = true;
    let waiting = false;
    let lastTime = video.currentTime;
    let width = 0;
    let height = 0;
    let viewport = danmakuViewport(0, 0, 0, 0);
    let layout: DanmakuLayout | undefined;

    const cancel = () => {
      if (raf !== undefined) window.cancelAnimationFrame(raf);
      if (wakeup !== undefined) window.clearTimeout(wakeup);
      raf = undefined;
      wakeup = undefined;
    };
    const schedule = () => {
      if (disposed) return;
      if (wakeup !== undefined) window.clearTimeout(wakeup);
      wakeup = undefined;
      if (raf === undefined) raf = window.requestAnimationFrame(draw);
    };
    const rebuild = () => {
      dirty = true;
      schedule();
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const ratio = clampDanmakuNumber(window.devicePixelRatio, 1, 2, 1);
      const pixelsWide = Math.max(1, Math.round(width * ratio));
      const pixelsHigh = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
      if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      viewport = danmakuViewport(width, height, video.videoWidth, video.videoHeight);
      layout = createDanmakuLayout(
        comments,
        { width: viewport.width, height: viewport.height, fontScale, reducedMotion: motion.matches },
        (text, size) => {
          context.font = font(size);
          return context.measureText(text).width;
        },
      );
      context.font = font(layout.fontSize);
      context.textBaseline = 'middle';
      context.lineJoin = 'round';
      context.lineWidth = Math.max(2, layout.fontSize / 8);
      context.strokeStyle = '#000000';
      dirty = false;
    };
    function draw() {
      raf = undefined;
      if (disposed) return;
      if (dirty) resize();
      context!.clearRect(0, 0, width, height);
      if (
        !layout ||
        document.hidden ||
        document.pictureInPictureElement === video ||
        video!.seeking ||
        video!.ended ||
        video!.error ||
        video!.readyState < 2
      )
        return;

      const time = video!.currentTime;
      const frame = sampleDanmaku(layout, time);
      context!.save();
      context!.beginPath();
      context!.rect(
        viewport.x,
        viewport.y,
        viewport.width,
        Math.max(0, viewport.height - layout.bottomInset),
      );
      context!.clip();
      context!.translate(viewport.x, viewport.y);
      context!.globalAlpha = latestOpacity.current;
      for (const comment of frame) {
        context!.fillStyle = comment.color;
        context!.strokeText(comment.text, comment.x, comment.y);
        context!.fillText(comment.text, comment.x, comment.y);
      }
      context!.restore();
      lastTime = time;
      if (video!.paused || waiting) return;
      if (frame.some((comment) => comment.mode === 'scroll')) schedule();
      else {
        const next = nextDanmakuChange(layout, time, frame);
        const rate = video!.playbackRate;
        if (Number.isFinite(next) && rate > 0)
          wakeup = window.setTimeout(schedule, Math.min(60_000, Math.max(16, ((next - time) / rate) * 1000)));
      }
    }

    const sync = () => {
      if (video.currentTime !== lastTime) waiting = false;
      schedule();
    };
    const playing = () => {
      waiting = false;
      schedule();
    };
    const stalled = () => {
      waiting = true;
      cancel();
      schedule();
    };
    const visibility = () => {
      cancel();
      schedule();
    };
    const mediaEvents: [string, () => void][] = [
      ['play', playing],
      ['playing', playing],
      ['pause', sync],
      ['timeupdate', sync],
      ['seeking', visibility],
      ['seeked', sync],
      ['ratechange', sync],
      ['loadedmetadata', rebuild],
      ['loadeddata', rebuild],
      ['resize', rebuild],
      ['waiting', stalled],
      ['stalled', stalled],
      ['ended', visibility],
      ['emptied', visibility],
      ['error', visibility],
      ['enterpictureinpicture', visibility],
      ['leavepictureinpicture', visibility],
    ];
    for (const [event, listener] of mediaEvents) video.addEventListener(event, listener);
    const observer = new ResizeObserver(rebuild);
    observer.observe(canvas.parentElement ?? canvas);
    window.addEventListener('resize', rebuild);
    document.addEventListener('fullscreenchange', rebuild);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', rebuild);
    redraw.current = schedule;
    schedule();

    return () => {
      disposed = true;
      cancel();
      observer.disconnect();
      for (const [event, listener] of mediaEvents) video.removeEventListener(event, listener);
      window.removeEventListener('resize', rebuild);
      document.removeEventListener('fullscreenchange', rebuild);
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', rebuild);
      if (redraw.current === schedule) redraw.current = undefined;
      context.clearRect(0, 0, width, height);
    };
  }, [comments, enabled, fontScale, videoRef]);

  return <canvas ref={canvasRef} className="danmaku-layer" hidden={!enabled} aria-hidden="true" />;
}
