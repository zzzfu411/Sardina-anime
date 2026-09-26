import { refKey, type AnimeCard, type Episode, type SearchGroup } from './types';

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s·・:：!！?？“”「」『』《》]/g, '');
}

export function sameAnime(a: AnimeCard, b: AnimeCard): boolean {
  if (a.sourceId === b.sourceId && a.id === b.id) return true;
  // Known conflicting editions must not be merged even when a provider supplied a bad external ID.
  if (a.year && b.year && a.year !== b.year) return false;
  if (a.season !== undefined && b.season !== undefined && a.season !== b.season) return false;
  if (a.kind !== 'unknown' && b.kind !== 'unknown' && a.kind !== b.kind) return false;
  for (const [key, value] of Object.entries(a.externalIds ?? {})) {
    if (value && b.externalIds?.[key] === value) return true;
  }
  return (
    normalizeTitle(a.title) === normalizeTitle(b.title) &&
    a.year !== undefined &&
    a.year === b.year &&
    a.season !== undefined &&
    a.season === b.season &&
    a.kind !== 'unknown' &&
    a.kind === b.kind
  );
}

export function groupAnime(items: AnimeCard[]): SearchGroup[] {
  const groups: SearchGroup[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(refKey(item))) continue;
    seen.add(refKey(item));
    const group = groups.find((g) => g.items.every((other) => sameAnime(other, item)));
    if (group) group.items.push(item);
    else groups.push({ id: refKey(item), title: item.title, items: [item] });
  }
  return groups;
}

export function chineseNumber(text: string): number | null {
  const chars: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (/^[零〇一二两三四五六七八九]+$/.test(text)) return Number([...text].map((c) => chars[c]).join(''));
  let sum = 0,
    digit = 0;
  for (const c of text) {
    if (c in chars) digit = chars[c];
    else if (c === '十' || c === '百') {
      sum += (digit || 1) * (c === '十' ? 10 : 100);
      digit = 0;
    } else return null;
  }
  return sum + digit;
}

export function episodeNumber(label: string): number | null {
  const text = label.normalize('NFKC').trim();
  const m =
    text.match(/^(?:第\s*|(?:ep|episode)\s*)?(\d+(?:\.\d+)?)\s*(?:[集话話回]|$)/i) ??
    text.match(/第\s*([零〇一二两三四五六七八九十百]+)\s*[集话話回]/);
  if (!m) return null;
  return /^\d/.test(m[1]) ? Number(m[1]) : chineseNumber(m[1]);
}

export function matchingEpisode(source: Episode, candidates: Episode[]): Episode | undefined {
  if (source.number === null) return undefined;
  const matches = candidates.filter((e) => e.kind === source.kind && e.number === source.number);
  return matches.length === 1 ? matches[0] : undefined;
}

export function inferKind(title: string): AnimeCard['kind'] {
  if (/剧场版|劇場版|电影/.test(title)) return 'movie';
  if (/\bOVA\b|\bOAD\b/i.test(title)) return 'ova';
  if (/特别篇|特別篇|总集篇/.test(title)) return 'special';
  return 'unknown';
}

export function inferSeason(title: string): number | undefined {
  const m = title.match(/第\s*([\d一二三四五六七八九十]+)\s*季|season\s*(\d+)/i);
  if (!m) return undefined;
  const n = Number(m[1] || m[2]);
  return Number.isFinite(n) ? n : (chineseNumber(m[1]) ?? undefined);
}
