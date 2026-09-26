import { describe, expect, it } from 'vitest';
import {
  createDanmakuLayout,
  danmakuViewport,
  nextDanmakuChange,
  sampleDanmaku,
  type DanmakuItem,
} from '../apps/web/src/danmaku-layout';

const item = (id: number, overrides: Partial<DanmakuItem> = {}): DanmakuItem => ({
  id: String(id),
  time: id,
  mode: 'scroll',
  text: `评论 ${id}`,
  color: '#ffffff',
  ...overrides,
});
const measure = (text: string, font: number) => Array.from(text).length * font;
const size = { width: 640, height: 360 };

describe('danmaku media-time layout', () => {
  it('reconstructs the same frame after a backwards seek without flooding skipped comments', () => {
    const layout = createDanmakuLayout([item(80), item(10), item(0), item(40)], size, measure);
    const initial = sampleDanmaku(layout, 11);
    expect(initial.map((comment) => comment.id)).toEqual(['10']);
    expect(sampleDanmaku(layout, 70)).toEqual([]);
    expect(sampleDanmaku(layout, 11)).toEqual(initial);
    expect(sampleDanmaku(layout, 9).some((comment) => comment.id === '10')).toBe(false);
    expect(sampleDanmaku(layout, Infinity)).toEqual([]);
    expect(sampleDanmaku(layout, -1)).toEqual([]);
  });

  it('never admits a following scroll until its predecessor has enough space', () => {
    const layout = createDanmakuLayout(
      Array.from({ length: 120 }, (_, index) =>
        item(index, { time: index / 5, text: index % 2 ? '长'.repeat(50) : '短' }),
      ),
      { width: 400, height: 110 },
      measure,
    );
    expect(layout.placements.length).toBeGreaterThan(2);
    for (let time = 0; time < 30; time += 0.05) {
      const visible = sampleDanmaku(layout, time).sort((a, b) => a.x - b.x);
      for (let index = 1; index < visible.length; index++)
        expect(visible[index - 1].x + visible[index - 1].width + 23.9).toBeLessThanOrEqual(visible[index].x);
    }
  });

  it('keeps all modes in separate rows and leaves subtitles and native controls clear', () => {
    const comments = ['top', 'bottom', 'scroll'].flatMap((mode, index) =>
      Array.from({ length: 12 }, (_, n) =>
        item(index * 12 + n, { time: n / 2, mode: mode as DanmakuItem['mode'] }),
      ),
    );
    const layout = createDanmakuLayout(comments, size, measure);
    const rows = new Map<string, Set<number>>();
    for (const comment of layout.placements) {
      if (!rows.has(comment.mode)) rows.set(comment.mode, new Set());
      rows.get(comment.mode)!.add(comment.y);
      expect(comment.y + layout.lineHeight / 2).toBeLessThanOrEqual(layout.height - layout.bottomInset);
    }
    expect(rows.size).toBe(3);
    for (const row of rows.get('scroll')!) {
      expect(rows.get('top')!.has(row)).toBe(false);
      expect(rows.get('bottom')!.has(row)).toBe(false);
    }
    expect(Math.min(...rows.get('bottom')!)).toBeGreaterThan(Math.max(...rows.get('top')!));
  });

  it('does not overlap fixed and scrolling comments when the viewport only fits one row', () => {
    const layout = createDanmakuLayout(
      [item(0), item(1, { mode: 'top' }), item(2, { mode: 'bottom' }), item(15, { mode: 'top' })],
      { width: 400, height: 110 },
      measure,
    );
    expect(layout.placements.map((comment) => comment.id)).toEqual(['0', '15']);
  });

  it('bounds density under sustained bursts without displaying the backlog later', () => {
    const layout = createDanmakuLayout(
      Array.from({ length: 5_000 }, (_, id) => item(id, { time: id / 1_000, text: '好' })),
      { width: 1280, height: 720 },
      measure,
    );
    for (let time = 0; time < 25; time += 0.25)
      expect(sampleDanmaku(layout, time).length).toBeLessThanOrEqual(24);
    expect(layout.placements.length).toBeLessThan(100);
    expect(layout.placements.every((comment) => comment.time < 5)).toBe(true);
    expect(sampleDanmaku(layout, 25)).toEqual([]);
  });

  it('fits long Unicode text without accepting markup or unsafe styling as instructions', () => {
    const layout = createDanmakuLayout(
      [
        item(0, { text: '😀'.repeat(500), color: 'url(https://invalid.example/image)' }),
        item(10, { text: '<img src=x onerror=alert(1)>\n评论', mode: 'top' }),
        item(20, { text: '  \u202e正常\u202c   文本\t', mode: 'top' }),
        item(30, { time: NaN }),
        item(40, { time: -1 }),
        item(50, { text: ' \n\t ' }),
      ],
      { width: 320, height: 180, fontScale: 1.5 },
      measure,
    );
    expect(layout.placements).toHaveLength(3);
    expect(layout.placements[0].color).toBe('#ffffff');
    expect(layout.placements[0].text.endsWith('…')).toBe(true);
    expect(layout.placements[0].text).not.toContain('\ufffd');
    expect(layout.placements.every((comment) => comment.width <= 320 * 0.85)).toBe(true);
    expect(layout.placements[1].text.startsWith('<img')).toBe(true);
    expect(layout.placements[2].text).toBe('正常 文本');
  });

  it('uses fixed comments for reduced motion and supplies exact wake-up boundaries', () => {
    const layout = createDanmakuLayout(
      [item(1), item(20, { mode: 'bottom' })],
      { ...size, reducedMotion: true },
      measure,
    );
    const first = sampleDanmaku(layout, 1);
    expect(first).toHaveLength(1);
    expect(first[0].mode).toBe('top');
    expect(sampleDanmaku(layout, 3)[0].x).toBe(first[0].x);
    expect(nextDanmakuChange(layout, 0, [])).toBe(1);
    expect(nextDanmakuChange(layout, 1, first)).toBe(5);
    expect(sampleDanmaku(layout, 5)).toEqual([]);
    expect(nextDanmakuChange(layout, 5, [])).toBe(20);
    expect(nextDanmakuChange(layout, 24, [])).toBe(Infinity);
  });

  it('keeps comments inside the displayed video when a fullscreen stage is letterboxed', () => {
    expect(danmakuViewport(1600, 1000, 1920, 1080)).toEqual({ x: 0, y: 50, width: 1600, height: 900 });
    expect(danmakuViewport(1600, 900, 640, 480)).toEqual({ x: 200, y: 0, width: 1200, height: 900 });
    expect(danmakuViewport(320, 180, 0, 0)).toEqual({ x: 0, y: 0, width: 320, height: 180 });
  });

  it('suppresses overlays when the available picture is too small and normalizes invalid preferences', () => {
    expect(createDanmakuLayout([item(1)], { width: 64, height: 64 }, measure).placements).toEqual([]);
    expect(createDanmakuLayout([item(1)], { width: Infinity, height: NaN }, measure).placements).toEqual([]);
    const layout = createDanmakuLayout([item(1)], { ...size, fontScale: NaN }, measure);
    expect(layout.fontSize).toBe(20);
    expect(layout.placements).toHaveLength(1);
  });
});
