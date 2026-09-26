import type { AnimeCard, CatalogFilter, MediaKind } from './types';

export const kindLabels: Record<MediaKind, string> = {
  tv: 'TV 动画',
  movie: '剧场版',
  ova: 'OVA',
  special: '特别篇',
  unknown: '类型未标注',
};
export const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const yearFilter = (): CatalogFilter => ({
  key: 'year',
  label: '年份',
  options: [
    { value: '', label: '全部' },
    ...Array.from({ length: new Date().getFullYear() - 1899 }, (_, i) => {
      const value = String(new Date().getFullYear() - i);
      return { value, label: value };
    }),
  ],
});

export function refineSearch(items: AnimeCard[], kind: string, year: string, sort: string): AnimeCard[] {
  const filtered = items.filter(
    (card) => (!kind || card.kind === kind) && (!year || String(card.year ?? 'unknown') === year),
  );
  if (sort === 'year') return filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  if (sort === 'title')
    return filtered.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));
  return filtered;
}
