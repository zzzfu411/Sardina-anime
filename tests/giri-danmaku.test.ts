import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGiriDanmaku, updateGiriAudience } from '../packages/engine/src/sources/giri-danmaku';
import { HttpClient, type HttpOptions } from '../packages/engine/src/http';

const MEDIA = 'https://akua.girigirilove.com/example/01/playlist.m3u8';
const XML = 'https://akua.girigirilove.com/example/01.xml';
const http = new HttpClient();

afterEach(() => {
  vi.restoreAllMocks();
  http.close();
});

function responses(native: unknown = [], external: unknown = '', xml = '<i></i>') {
  return vi.spyOn(http, 'bytes').mockImplementation(async (url) => {
    const data = url.endsWith('/getScrolling')
      ? { code: 1, info: native }
      : url.endsWith('/getVodOutScrolling')
        ? { code: 1, info: external }
        : xml;
    if (url !== XML && !url.startsWith('https://m3u8.girigirilove.com/api.php/Scrolling/'))
      throw new Error('Unexpected host');
    return {
      body: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)),
      url,
      contentType: '',
    };
  });
}

function item(time = 1.25, content = '你好', mode = 1, color = '#ffffff', id = 1) {
  return { scroll_id: id, scroll_json: { stime: 0, text: '', time, content, mode, style: { color } } };
}

describe('girigiri danmaku', () => {
  it('merges native seconds with XML seconds, maps the two mode formats, and deduplicates both sources', async () => {
    const read = responses(
      [item(12.994904), item(5, '顶', 2, '#f00'), item(8, '底', 3, '#000000')],
      XML,
      `<?xml version="1.0"?><i><d p="12.994904,1,25,16777215,0,0,user,10">你好</d><d p="3.5,4,25,0,0,0,user,11">底部 &amp; 字符</d><d p="2,5,25,65280,0,0,user,12">顶端</d></i>`,
    );
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed.comments.map(({ time, mode, color, text }) => ({ time, mode, color, text }))).toEqual([
      { time: 2, mode: 'top', color: '#00ff00', text: '顶端' },
      { time: 3.5, mode: 'bottom', color: '#000000', text: '底部 & 字符' },
      { time: 5, mode: 'top', color: '#ff0000', text: '顶' },
      { time: 8, mode: 'bottom', color: '#000000', text: '底' },
      { time: 12.994904, mode: 'scroll', color: '#ffffff', text: '你好' },
    ]);
    expect(feed).toMatchObject({ total: 5, truncated: false });
    expect(feed.warnings).toBeUndefined();
    expect(Number.isFinite(Date.parse(feed.fetchedAt))).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    for (const [url, options, limit] of read.mock.calls) {
      expect(limit).toBe(8 * 1024 * 1024);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.timeout).toBe(15_000);
      expect(options?.allowedHosts).toEqual([
        url === XML ? 'akua.girigirilove.com' : 'm3u8.girigirilove.com',
      ]);
      if (url !== XML) {
        expect(options?.method).toBe('POST');
        expect(JSON.parse(options?.body ?? '')).toEqual({ play_url: MEDIA });
      }
    }
  });

  it('keeps literal content bounded, removes controls, sanitizes colors, and skips invalid times and modes', async () => {
    responses([
      item(-1),
      item(Infinity),
      item(86_401),
      item(2, 'invalid', 9),
      item(2, '  \u0000\n  '),
      item(0, '<img onerror="code()">\u0000  literal', 1, 'url(https://untrusted.example/pixel)'),
      item(1, '字'.repeat(500), 1, '#AbCdEf'),
    ]);
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed.comments).toHaveLength(2);
    expect(feed.comments[0]).toMatchObject({
      time: 0,
      text: '<img onerror="code()"> literal',
      color: '#ffffff',
    });
    expect(feed.comments[1].text).toHaveLength(300);
    expect(feed.comments[1].color).toBe('#abcdef');
  });

  it.each([
    'https://127.0.0.1/secret.xml',
    'https://attacker.example/01.xml',
    'https://akua.girigirilove.com.attacker.example/01.xml',
    'http://akua.girigirilove.com/01.xml',
    'https://akua.girigirilove.com:8443/01.xml',
    'https://akua.girigirilove.com/example/playlist.m3u8',
  ])('rejects external address %s and preserves available native comments', async (external) => {
    const read = responses([item()], external);
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed.total).toBe(1);
    expect(feed.warnings).toEqual(['外部弹幕暂时不可用，已显示站内弹幕。']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    '<html>blocked</html>',
    '<!DOCTYPE i [<!ENTITY x SYSTEM "file:///etc/passwd">]><i>&x;</i>',
    '<i><d p="1,1">broken',
  ])('rejects malformed or external-entity XML without losing native comments', async (xml) => {
    responses([item()], XML, xml);
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed.total).toBe(1);
    expect(feed.warnings).toHaveLength(1);
  });

  it('preserves XML comments and warns when the native service shape changes', async () => {
    responses({ changed: true }, XML, '<i><d p="1,1,25,255,0,0,u,2">外部</d></i>');
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed.comments).toMatchObject([{ text: '外部', color: '#0000ff' }]);
    expect(feed.warnings).toEqual(['站内弹幕暂时不可用，已显示外部弹幕。']);
  });

  it('recognizes a changed native entry schema while accepting a genuine self-closing empty XML feed', async () => {
    responses([{ changed: true }], XML, '<?xml version="1.0"?><i />');
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed).toMatchObject({ total: 0, truncated: false });
    expect(feed.warnings).toEqual(['站内弹幕暂时不可用，已显示外部弹幕。']);
  });

  it('skips invalid object modes without discarding valid entries and keeps duplicate upstream IDs distinct', async () => {
    responses([
      { scroll_id: 1, scroll_json: { time: 1, content: 'bad', mode: { valueOf: null, toString: null } } },
      item(1, '一', 1, '#fff', 7),
      item(2, '二', 1, '#fff', 7),
    ]);
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed.comments.map((entry) => entry.text)).toEqual(['一', '二']);
    expect(new Set(feed.comments.map((entry) => entry.id)).size).toBe(2);
    expect(feed.warnings).toBeUndefined();
  });

  it('reports an unavailable feed when both services fail rather than pretending it has zero comments', async () => {
    vi.spyOn(http, 'bytes').mockRejectedValue(new Error('offline'));
    await expect(getGiriDanmaku(MEDIA, { http })).rejects.toMatchObject({ code: 'DANMAKU_UNAVAILABLE' });
  });

  it('accepts genuinely empty feeds and produces stable identities for entries without IDs', async () => {
    const read = responses([], null);
    expect(await getGiriDanmaku(MEDIA, { http })).toMatchObject({ comments: [], total: 0, truncated: false });
    read.mockRestore();
    responses([{ scroll_json: { time: 2, content: '无编号', mode: 1 } }]);
    const first = await getGiriDanmaku(MEDIA, { http });
    const second = await getGiriDanmaku(MEDIA, { http });
    expect(first.comments[0].id).toBe(second.comments[0].id);
  });

  it('bounds the delivered feed while reporting the actual unique valid count', async () => {
    responses(
      Array.from({ length: 20_005 }, (_, index) => item(20_005 - index, '弹幕' + index, 1, '#fff', index)),
    );
    const feed = await getGiriDanmaku(MEDIA, { http });
    expect(feed.comments).toHaveLength(20_000);
    expect(feed).toMatchObject({ total: 20_005, truncated: true });
    expect(feed.comments[0].time).toBe(1);
    expect(feed.comments.at(-1)?.time).toBe(20_000);
  });

  it('rejects local media before any upstream request and propagates caller cancellation', async () => {
    const read = responses();
    await expect(getGiriDanmaku('http://127.0.0.1/private', { http })).rejects.toMatchObject({
      code: 'BLOCKED_ADDRESS',
    });
    expect(read).not.toHaveBeenCalled();
    const controller = new AbortController();
    const reason = new Error('caller left');
    controller.abort(reason);
    await expect(getGiriDanmaku(MEDIA, { http, signal: controller.signal })).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
  });

  it('stops awaiting an in-flight read when the caller leaves, even if DNS or the transport is still pending', async () => {
    vi.spyOn(http, 'bytes').mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = getGiriDanmaku(MEDIA, { http, signal: controller.signal });
    const reason = new Error('left while connecting');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe('girigiri audience', () => {
  it.each(['open', 'close'] as const)(
    'sends exactly one %s request, including a legitimate zero count',
    async (action) => {
      const read = vi.spyOn(http, 'bytes').mockResolvedValue({
        body: Buffer.from(JSON.stringify({ code: 1, info: { count: 0 } })),
        url: '',
        contentType: '',
      });
      const result = await updateGiriAudience(MEDIA, action, { http });
      expect(result).toMatchObject({ count: 0, scope: 'episode-line' });
      expect(Number.isFinite(Date.parse(result.sampledAt))).toBe(true);
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0][0]).toBe('https://m3u8.girigirilove.com/api.php/Scrolling/playOnline');
      expect(JSON.parse((read.mock.calls[0][1] as HttpOptions).body!)).toEqual({
        play_url: MEDIA,
        do: action,
      });
      expect(read.mock.calls[0][2]).toBe(64 * 1024);
    },
  );

  it.each([undefined, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, null])(
    'does not turn malformed count %s into zero',
    async (count) => {
      vi.spyOn(http, 'bytes').mockResolvedValue({
        body: Buffer.from(JSON.stringify({ code: 1, info: { count } })),
        url: '',
        contentType: '',
      });
      await expect(updateGiriAudience(MEDIA, 'open', { http })).rejects.toMatchObject({
        code: 'INVALID_AUDIENCE_RESPONSE',
      });
    },
  );

  it('does not accept an upstream error payload or retry an uncertain presence mutation', async () => {
    const read = vi.spyOn(http, 'bytes').mockResolvedValue({
      body: Buffer.from(JSON.stringify({ code: 0, info: { count: 7 } })),
      url: '',
      contentType: '',
    });
    await expect(updateGiriAudience(MEDIA, 'open', { http })).rejects.toMatchObject({
      code: 'DANMAKU_UNAVAILABLE',
    });
    expect(read).toHaveBeenCalledOnce();
    read.mockClear().mockRejectedValue(new Error('timeout'));
    await expect(updateGiriAudience(MEDIA, 'open', { http })).rejects.toThrow('timeout');
    expect(read).toHaveBeenCalledOnce();
  });
});
