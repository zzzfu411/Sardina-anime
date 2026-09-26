import { Parser } from 'm3u8-parser';
import { AppError } from './errors';

export function rewriteHls(text: string, base: string, register: (url: string) => string): string {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('#EXTM3U')) throw new AppError('INVALID_HLS', '来源没有返回有效的 HLS 播放清单');
  try {
    const parser = new Parser();
    parser.push(normalized);
    parser.end();
  } catch {
    throw new AppError('INVALID_HLS', '来源返回的 HLS 清单格式不完整，请更换线路');
  }
  if (/\{\$[^}]+\}/.test(text))
    throw new AppError('UNSUPPORTED_HLS', '当前清单使用尚未支持的 HLS 变量，请更换线路');
  const address = (value: string) => {
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      throw new AppError('INVALID_HLS', '播放清单含有无效资源地址');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new AppError('INVALID_HLS', '播放清单含有不支持的资源协议');
    return register(url.href);
  };
  return normalized
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith('#')) return address(trimmed);
      const colon = line.indexOf(':');
      if (!line.startsWith('#EXT-X-') || colon < 0) return line;
      // Tokenize the attribute list, preserving unrecognized tags, commas in quoted values,
      // byte ranges, encryption IVs and the original ordering.
      const edits: { start: number; end: number; value: string }[] = [];
      let i = colon + 1;
      while (i < line.length) {
        while (line[i] === ',' || /\s/.test(line[i] || '')) i++;
        const keyStart = i;
        while (i < line.length && line[i] !== '=' && line[i] !== ',') i++;
        if (line[i] !== '=') {
          i++;
          continue;
        }
        const key = line.slice(keyStart, i).trim();
        i++;
        const quoted = line[i] === '"';
        if (quoted) i++;
        const start = i;
        while (i < line.length && (quoted ? line[i] !== '"' : line[i] !== ',')) i++;
        const end = i;
        if (key === 'URI' || key === 'SERVER-URI')
          edits.push({ start, end, value: address(line.slice(start, end)) });
        if (quoted) i++;
      }
      for (const edit of edits.reverse())
        line = line.slice(0, edit.start) + edit.value + line.slice(edit.end);
      return line;
    })
    .join('\n');
}
