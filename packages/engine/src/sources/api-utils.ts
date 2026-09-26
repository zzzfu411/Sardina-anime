import * as cheerio from 'cheerio';
import type { AnimeCard, CatalogInput, SourceManifest } from '../../../core/src/types';
import { AppError } from '../errors';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_RESPONSE', '来源返回的数据结构已变化');
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AppError('INVALID_RESPONSE', '来源没有返回有效列表');
  return value;
}
export function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}
export function plain(value: unknown): string {
  return cheerio.load(text(value)).text().trim();
}
export function numericId(value: unknown): string {
  const id = text(value);
  if (!/^[1-9]\d{0,14}$/.test(id)) throw new AppError('INVALID_LOCATOR', '来源条目或剧集编号无效', 400);
  return id;
}
export function checkedPage(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    throw new AppError('INVALID_PAGE', '页码无效', 400);
  return page;
}
export function checkedFilters(manifest: SourceManifest, input: CatalogInput) {
  checkedPage(input.page);
  for (const [key, value] of Object.entries(input.filters)) {
    if (!manifest.catalogFilters?.find((f) => f.key === key)?.options.some((o) => o.value === value))
      throw new AppError('INVALID_FILTER', '来源不支持所选筛选条件', 400);
  }
}
export function year(value: unknown): number | undefined {
  const s = text(value);
  return /^(?:19|20)\d{2}$/.test(s) ? Number(s) : undefined;
}
export function uniqueCards(cards: AnimeCard[]): AnimeCard[] {
  return [...new Map(cards.map((card) => [card.id, card])).values()];
}
// These APIs omit totals. Inspect the actual next page; never infer it from page size.
export function nextPageExists(current: string[], next: string[]): boolean {
  const seen = new Set(current);
  return current.length > 0 && next.some((id) => !seen.has(id));
}
