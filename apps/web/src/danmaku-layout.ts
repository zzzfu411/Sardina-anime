export interface DanmakuItem {
  id: string;
  time: number;
  mode: 'scroll' | 'top' | 'bottom';
  color: string;
  text: string;
}

export interface DanmakuPlacement extends DanmakuItem {
  end: number;
  width: number;
  y: number;
  speed: number;
}

export interface DanmakuLayout {
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
  bottomInset: number;
  maxVisible: number;
  maxDuration: number;
  placements: DanmakuPlacement[];
}

export interface DanmakuFrame extends DanmakuPlacement {
  x: number;
}

const STATIC_DURATION = 4;
const MAX_COMMENT_LENGTH = 80;
const MAX_INPUT_COMMENTS = 50_000;

export function clampDanmakuNumber(value: number, minimum: number, maximum: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

/** Match object-fit: contain so comments stay over the picture in fullscreen. */
export function danmakuViewport(width: number, height: number, mediaWidth: number, mediaHeight: number) {
  const outerWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const outerHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  if (!(mediaWidth > 0 && mediaHeight > 0 && Number.isFinite(mediaWidth) && Number.isFinite(mediaHeight)))
    return { x: 0, y: 0, width: outerWidth, height: outerHeight };
  const ratio = Math.min(outerWidth / mediaWidth, outerHeight / mediaHeight);
  const contentWidth = mediaWidth * ratio;
  const contentHeight = mediaHeight * ratio;
  return {
    x: (outerWidth - contentWidth) / 2,
    y: (outerHeight - contentHeight) / 2,
    width: contentWidth,
    height: contentHeight,
  };
}

function cleanText(value: string) {
  const normalized = value
    .slice(0, 1_024)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(normalized);
  return characters.length > MAX_COMMENT_LENGTH
    ? `${characters.slice(0, MAX_COMMENT_LENGTH - 1).join('')}…`
    : normalized;
}

function fitText(text: string, maxWidth: number, measure: (text: string) => number) {
  const width = measure(text);
  if (width <= maxWidth) return { text, width };
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${characters.slice(0, middle).join('')}…`) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  const fitted = `${characters.slice(0, low).join('')}…`;
  return { text: fitted, width: measure(fitted) };
}

/**
 * Build a deterministic, bounded schedule once per size/font change. Skipped dense
 * comments are never queued for later: their timestamps still belong to the video.
 */
export function createDanmakuLayout(
  comments: readonly DanmakuItem[],
  options: { width: number; height: number; fontScale?: number; reducedMotion?: boolean },
  measureText: (text: string, fontSize: number) => number,
): DanmakuLayout {
  const width = Math.max(0, Number.isFinite(options.width) ? options.width : 0);
  const height = Math.max(0, Number.isFinite(options.height) ? options.height : 0);
  const fontSize =
    Math.max(17, Math.min(26, width / 32)) * clampDanmakuNumber(options.fontScale ?? 1, 0.75, 1.5, 1);
  const lineHeight = Math.ceil(fontSize * 1.5);
  const topInset = 10;
  const bottomInset = Math.max(64, height * 0.28);
  const maxVisible = width < 600 ? 12 : 24;
  const rowCount = Math.max(0, Math.min(12, Math.floor((height - topInset - bottomInset) / lineHeight)));
  const layout: DanmakuLayout = {
    width,
    height,
    fontSize,
    lineHeight,
    bottomInset,
    maxVisible,
    maxDuration: STATIC_DURATION,
    placements: [],
  };
  if (width < 80 || !rowCount) return layout;

  const input = comments
    .slice(0, MAX_INPUT_COMMENTS)
    .filter(
      (comment) => Number.isFinite(comment.time) && comment.time >= 0 && typeof comment.text === 'string',
    )
    .map((comment) => ({
      ...comment,
      text: cleanText(comment.text),
      mode: options.reducedMotion && comment.mode === 'scroll' ? ('top' as const) : comment.mode,
      color: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(comment.color) ? comment.color : '#ffffff',
    }))
    .filter((comment) => comment.text && ['scroll', 'top', 'bottom'].includes(comment.mode))
    .sort((a, b) => a.time - b.time);

  const hasScroll = input.some((comment) => comment.mode === 'scroll');
  const hasTop = input.some((comment) => comment.mode === 'top');
  const hasBottom = input.some((comment) => comment.mode === 'bottom');
  // With fewer than three rows, modes share the available rows and use occupancy
  // checks instead of letting a fixed comment cover a moving comment.
  const dedicatedRows = rowCount >= 3;
  const topRows = dedicatedRows && hasTop ? (hasScroll ? 1 : Math.ceil(rowCount / (hasBottom ? 2 : 1))) : 0;
  const bottomRows = dedicatedRows && hasBottom ? (hasScroll ? 1 : rowCount - topRows) : 0;
  const lanes: (DanmakuPlacement | undefined)[] = Array.from({ length: rowCount });
  const visible: DanmakuPlacement[] = [];
  const gap = Math.max(24, fontSize);
  // All scrolling comments share one velocity. A longer following comment cannot
  // catch a shorter one already on screen, including at non-default playback rates.
  const speed = width / 7.5;
  const widths = new Map<string, number>();
  const measure = (text: string) => {
    if (!widths.has(text)) {
      const measured = measureText(text, fontSize);
      widths.set(text, Number.isFinite(measured) ? Math.max(0, measured) : width);
    }
    return widths.get(text)!;
  };
  let cursor = 0;
  for (const comment of input) {
    for (let index = visible.length - 1; index >= 0; index--)
      if (visible[index].end <= comment.time) visible.splice(index, 1);
    if (visible.length >= maxVisible) continue;

    let first = 0;
    let last = rowCount;
    if (dedicatedRows) {
      if (comment.mode === 'top') last = topRows;
      else if (comment.mode === 'bottom') first = rowCount - bottomRows;
      else {
        first = topRows;
        last = rowCount - bottomRows;
      }
    }
    const count = last - first;
    if (!count) continue;
    let selected = -1;
    for (let offset = 0; offset < count; offset++) {
      const row = first + ((cursor + offset) % count);
      const previous = lanes[row];
      const exited = !previous || previous.end <= comment.time;
      const separated =
        previous?.mode === 'scroll' &&
        comment.mode === 'scroll' &&
        speed * (comment.time - previous.time) >= previous.width + gap;
      if (exited || separated) {
        selected = row;
        break;
      }
    }
    if (selected < 0) continue;

    const fitted = fitText(comment.text, width * 0.85, measure);
    if (!(fitted.width > 0 && fitted.width <= width * 0.85)) continue;
    const duration = comment.mode === 'scroll' ? (width + fitted.width) / speed : STATIC_DURATION;
    const placement: DanmakuPlacement = {
      ...comment,
      ...fitted,
      end: comment.time + duration,
      y: topInset + selected * lineHeight + lineHeight / 2,
      speed: comment.mode === 'scroll' ? speed : 0,
    };
    layout.placements.push(placement);
    layout.maxDuration = Math.max(layout.maxDuration, duration);
    lanes[selected] = placement;
    visible.push(placement);
    cursor++;
  }
  return layout;
}

function afterTime(placements: readonly DanmakuPlacement[], time: number) {
  let low = 0;
  let high = placements.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (placements[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Pure media-time sampling makes pause, seek, replay and playback rate equivalent. */
export function sampleDanmaku(layout: DanmakuLayout, time: number): DanmakuFrame[] {
  if (!Number.isFinite(time) || time < 0) return [];
  const start = afterTime(layout.placements, time - layout.maxDuration);
  const end = afterTime(layout.placements, time);
  const frame: DanmakuFrame[] = [];
  for (let index = start; index < end; index++) {
    const comment = layout.placements[index];
    if (comment.end <= time) continue;
    frame.push({
      ...comment,
      x:
        comment.mode === 'scroll'
          ? layout.width - comment.speed * (time - comment.time)
          : (layout.width - comment.width) / 2,
    });
  }
  return frame;
}

/** Used to sleep between fixed comments instead of keeping an idle RAF loop alive. */
export function nextDanmakuChange(layout: DanmakuLayout, time: number, frame: readonly DanmakuFrame[]) {
  const next = layout.placements[afterTime(layout.placements, time)]?.time ?? Infinity;
  return Math.min(next, ...frame.map((comment) => comment.end));
}
