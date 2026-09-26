import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AudienceSnapshot, DanmakuComment, DanmakuFeed } from '../../../core/src/types';
import { AppError, abortable } from '../errors';
import { validateUrl, type HttpOptions } from '../http';
import type { SourceContext } from './types';

const API = 'https://m3u8.girigirilove.com/api.php/Scrolling/';
const API_HOSTS = ['m3u8.girigirilove.com'];
const XML_HOSTS = ['akua.girigirilove.com'];
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_COMMENTS = 20_000;
const MAX_TEXT = 300;
const MAX_TIME = 24 * 60 * 60;
const TIMEOUT = 15_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mediaAddress(raw: string) {
  if (raw.length > 8192) throw new AppError('INVALID_URL', '播放地址过长');
  return validateUrl(raw).href;
}

function options(ctx: SourceContext, allowedHosts: string[]): HttpOptions {
  return {
    allowedHosts,
    timeout: TIMEOUT,
    signal: ctx.signal,
    headers: { Referer: 'https://giri.moemoekyu.com/', 'Content-Type': 'application/json' },
  };
}

function boundedContext(ctx: SourceContext): SourceContext {
  const timeout = AbortSignal.timeout(TIMEOUT);
  return { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout };
}

async function post(
  action: 'getScrolling' | 'getVodOutScrolling' | 'playOnline',
  body: Record<string, string>,
  ctx: SourceContext,
) {
  ctx.signal?.throwIfAborted();
  const response = await abortable(
    ctx.http.bytes(
      API + action,
      { ...options(ctx, API_HOSTS), method: 'POST', body: JSON.stringify(body) },
      action === 'playOnline' ? 64 * 1024 : MAX_BYTES,
    ),
    ctx.signal!,
  );
  let data: Record<string, unknown> | undefined;
  try {
    data = record(JSON.parse(response.body.toString('utf8')));
  } catch {
    throw new AppError('INVALID_DANMAKU_RESPONSE', 'girigiri 弹幕服务返回了无效数据');
  }
  if (!data || data.code !== 1) throw new AppError('DANMAKU_UNAVAILABLE', 'girigiri 弹幕服务暂时无法使用');
  return data;
}

function seconds(value: unknown) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)))
    return undefined;
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 && time <= MAX_TIME ? time : undefined;
}

function text(value: unknown) {
  if (typeof value !== 'string') return '';
  // Keep comments as literal text; never interpret upstream content as HTML or CSS.
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function color(value: unknown) {
  if (typeof value === 'string') {
    if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
    if (/^#[\da-f]{3}$/i.test(value))
      return '#' + [...value.slice(1).toLowerCase()].map((digit) => digit + digit).join('');
    if (!/^\d{1,8}$/.test(value)) return '#ffffff';
  } else if (typeof value !== 'number') return '#ffffff';
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0xffffff
    ? '#' + numeric.toString(16).padStart(6, '0')
    : '#ffffff';
}

function comment(
  id: unknown,
  time: unknown,
  mode: DanmakuComment['mode'] | undefined,
  content: unknown,
  tint: unknown,
  origin: 'site' | 'xml',
): DanmakuComment | undefined {
  const parsedTime = seconds(time);
  const parsedText = text(content);
  if (parsedTime === undefined || !mode || !parsedText) return undefined;
  const parsedColor = color(tint);
  const rawId = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([parsedTime, mode, parsedColor, parsedText]))
    .digest('hex')
    .slice(0, 24);
  const stableId = /^[\w.-]{1,100}$/.test(rawId) ? rawId + ':' + fingerprint : fingerprint;
  return { id: origin + ':' + stableId, time: parsedTime, mode, color: parsedColor, text: parsedText };
}

function parseNative(data: unknown): DanmakuComment[] {
  if (!Array.isArray(data)) throw new AppError('INVALID_DANMAKU_RESPONSE', 'girigiri 站内弹幕格式已变化');
  const comments: DanmakuComment[] = [];
  let recognized = 0;
  for (const item of data) {
    const entry = record(item);
    const fields = record(entry?.scroll_json);
    if (!fields) continue;
    recognized++;
    const nativeMode =
      typeof fields.mode === 'number' || typeof fields.mode === 'string' ? Number(fields.mode) : NaN;
    const mode = { 1: 'scroll', 2: 'top', 3: 'bottom' }[nativeMode] as DanmakuComment['mode'] | undefined;
    const parsed = comment(
      entry?.scroll_id,
      Object.hasOwn(fields, 'time') ? fields.time : fields.stime,
      mode,
      fields.content || fields.text,
      record(fields.style)?.color ?? fields.color,
      'site',
    );
    if (parsed) comments.push(parsed);
  }
  if (data.length && !recognized)
    throw new AppError('INVALID_DANMAKU_RESPONSE', 'girigiri 站内弹幕格式已变化');
  return comments;
}

function parseXml(xml: string): DanmakuComment[] {
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !/^\s*(?:<\?xml[^?]*\?>\s*)?<i(?:\s[^>]*)?(?:\s*\/>|>[\s\S]*<\/i>)\s*$/i.test(xml)
  )
    throw new AppError('INVALID_DANMAKU_RESPONSE', 'girigiri 外部弹幕格式已变化');
  const $ = cheerio.load(xml, { xml: { xmlMode: true, decodeEntities: true } });
  if ($.root().children().length !== 1 || $.root().children()[0]?.tagName !== 'i')
    throw new AppError('INVALID_DANMAKU_RESPONSE', 'girigiri 外部弹幕格式已变化');
  const comments: DanmakuComment[] = [];
  for (const node of $('i > d').toArray()) {
    const fields = ($(node).attr('p') ?? '').split(',');
    const nativeMode = Number(fields[1]);
    const mode = [1, 2, 3].includes(nativeMode)
      ? 'scroll'
      : nativeMode === 4
        ? 'bottom'
        : nativeMode === 5
          ? 'top'
          : undefined;
    const parsed = comment(fields[7], fields[0], mode, $(node).text(), fields[3], 'xml');
    if (parsed) comments.push(parsed);
  }
  return comments;
}

async function externalComments(mediaUrl: string, ctx: SourceContext) {
  const data = await post('getVodOutScrolling', { play_url: mediaUrl }, ctx);
  if (data.info === null || data.info === '') return [];
  if (typeof data.info !== 'string')
    throw new AppError('INVALID_DANMAKU_RESPONSE', 'girigiri 外部弹幕地址无效');
  const url = validateUrl(data.info, XML_HOSTS);
  if (url.protocol !== 'https:' || url.port || !/\.xml$/i.test(url.pathname))
    throw new AppError('BLOCKED_URL', 'girigiri 外部弹幕地址不符合访问规则');
  const response = await abortable(ctx.http.bytes(url.href, options(ctx, XML_HOSTS), MAX_BYTES), ctx.signal!);
  return parseXml(response.body.toString('utf8'));
}

export async function getGiriDanmaku(mediaUrl: string, ctx: SourceContext): Promise<DanmakuFeed> {
  const address = mediaAddress(mediaUrl);
  const bounded = boundedContext(ctx);
  const responses = await Promise.allSettled([
    post('getScrolling', { play_url: address }, bounded).then((data) => parseNative(data.info)),
    externalComments(address, bounded),
  ]);
  ctx.signal?.throwIfAborted();
  if (responses.every((result) => result.status === 'rejected'))
    throw new AppError('DANMAKU_UNAVAILABLE', 'girigiri 弹幕暂时无法读取，请稍后重试');
  const warnings: string[] = [];
  const seen = new Set<string>();
  const comments: DanmakuComment[] = [];
  for (const [index, result] of responses.entries()) {
    if (result.status === 'rejected') {
      warnings.push(
        index === 0 ? '站内弹幕暂时不可用，已显示外部弹幕。' : '外部弹幕暂时不可用，已显示站内弹幕。',
      );
      continue;
    }
    for (const entry of result.value) {
      const identity = JSON.stringify([entry.time, entry.mode, entry.color, entry.text]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      comments.push(entry);
    }
  }
  comments.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  return {
    comments: comments.slice(0, MAX_COMMENTS),
    total: comments.length,
    truncated: comments.length > MAX_COMMENTS,
    fetchedAt: new Date().toISOString(),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** One call per actual enter/leave lifecycle. `open` changes upstream presence and is not a polling API. */
export async function updateGiriAudience(
  mediaUrl: string,
  action: 'open' | 'close',
  ctx: SourceContext,
): Promise<AudienceSnapshot> {
  if (action !== 'open' && action !== 'close') throw new AppError('INVALID_ACTION', '观看人数操作无效', 400);
  const data = await post(
    'playOnline',
    { play_url: mediaAddress(mediaUrl), do: action },
    boundedContext(ctx),
  );
  const count = record(data.info)?.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    throw new AppError('INVALID_AUDIENCE_RESPONSE', 'girigiri 暂未返回有效的观看人数');
  return { count, scope: 'episode-line', sampledAt: new Date().toISOString() };
}
