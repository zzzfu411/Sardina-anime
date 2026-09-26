import type { SourceRating } from '../../core/src/types';

export function sourceRating(
  value: unknown,
  label: string,
  total?: unknown,
  origin: SourceRating['origin'] = 'source',
): SourceRating[] {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^\d+(?:\.\d+)?$/.test(String(value).trim())
  )
    return [];
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0 || score > 10) return [];
  const count = typeof total === 'number' || typeof total === 'string' ? Number(total) : NaN;
  if (count === 0) return [];
  return [{ label, score, origin, ...(Number.isSafeInteger(count) && count > 0 ? { total: count } : {}) }];
}
