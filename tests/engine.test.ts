import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../packages/engine/src/store';
import { Registry } from '../packages/engine/src/registry';
import { createServer } from '../packages/engine/src/server';
import { HttpClient, isPublicAddress, validateUrl } from '../packages/engine/src/http';
import { MediaGateway } from '../packages/engine/src/media';
import { card, episode, fakeSource, response } from './helpers';
import type { SearchEvent } from '../packages/core/src/types';
import type { HttpResponse } from '../packages/engine/src/http';

const stores: Store[] = [];
const store = () => {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) if (s.db.open) s.close();
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('cancels running and queued library checks before closing the profile', async () => {
  const s = store();
  s.addLibrary(card, 'watching');
  let signal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const registry = new Registry(s, [
    fakeSource('fixture', {
      getDetail: async (_ref, ctx) => {
        signal = ctx.signal;
        started();
        return new Promise(() => {});
      },
    }),
  ]);
  const first = registry.checkLibrary();
  const queued = registry.checkLibrary();
  const done = Promise.allSettled([first, queued]);
  await ready;
  registry.close();
  s.close();
  for (const result of await done) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason.name).toBe('AbortError');
  }
  expect(signal?.aborted).toBe(true);
});

describe('explicit search source selection', () => {
  const headers = { host: '127.0.0.1', authorization: 'Bearer source-test-token' };
  it('requests only the selected source on the first page and later pages, and keeps search history', async () => {
    const selected = vi.fn(async (input: { page: number }) => ({
      items: [card],
      page: input.page,
      hasMore: true,
    }));
    const other = vi.fn(async () => ({ items: [], page: 1, hasMore: false }));
    const server = await createServer({
      database: ':memory:',
      token: 'source-test-token',
      updates: false,
      sources: [fakeSource('fixture', { search: selected }), fakeSource('other', { search: other })],
    });
    try {
      const response = await server.app.inject({ url: '/api/v1/search?q=stars&sourceId=fixture', headers });
      const events = response.body
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
      expect(events.filter((event) => event.sourceId).every((event) => event.sourceId === 'fixture')).toBe(
        true,
      );
      expect(events.some((event) => event.type === 'result')).toBe(true);
      expect(server.store.searchHistory()[0]?.keyword).toBe('stars');
      await server.app.inject({
        url:
          '/api/v1/search?' +
          new URLSearchParams({
            q: 'stars',
            sourceId: 'fixture',
            pages: JSON.stringify({ fixture: 2 }),
            cursors: JSON.stringify({ fixture: '42' }),
          }),
        headers,
      });
      expect(selected).toHaveBeenCalledTimes(2);
      expect(selected.mock.calls.at(-1)?.[0]).toEqual({ keyword: 'stars', page: 2, cursor: '42' });
      expect(other).not.toHaveBeenCalled();
    } finally {
      await server.app.close();
    }
  });
  it('rejects unavailable sources and cross-source pagination without searching any source', async () => {
    const search = vi.fn(async () => ({ items: [], page: 1, hasMore: false }));
    const source = fakeSource('fixture', { search });
    const noSearch = fakeSource('browse', { search });
    noSearch.manifest.capabilities = ['home'];
    const server = await createServer({
      database: ':memory:',
      token: 'source-test-token',
      updates: false,
      sources: [source, noSearch],
    });
    try {
      expect(
        (await server.app.inject({ url: '/api/v1/search?q=stars&sourceId=missing', headers })).statusCode,
      ).toBe(404);
      expect(
        (await server.app.inject({ url: '/api/v1/search?q=stars&sourceId=browse', headers })).statusCode,
      ).toBe(409);
      for (const field of ['pages', 'cursors']) {
        const query = new URLSearchParams({
          q: 'stars',
          sourceId: 'fixture',
          [field]: JSON.stringify({ other: field === 'pages' ? 2 : '42' }),
        });
        expect((await server.app.inject({ url: '/api/v1/search?' + query, headers })).statusCode).toBe(400);
      }
      server.store.saveSourceSettings('fixture', false, 0);
      expect(
        (await server.app.inject({ url: '/api/v1/search?q=stars&sourceId=fixture', headers })).statusCode,
      ).toBe(409);
      expect(search).not.toHaveBeenCalled();
      expect(server.store.searchHistory()).toEqual([]);
    } finally {
      await server.app.close();
    }
  });
});

describe('progressive source scheduling', () => {
  it('does not mark a source unhealthy when its last page reader leaves', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const registry = new Registry(store(), [
      fakeSource('fixture', {
        getHome: async () => {
          started();
          return new Promise(() => {});
        },
      }),
    ]);
    const read = registry.home('fixture', controller.signal);
    await ready;
    controller.abort();
    await expect(read).rejects.toHaveProperty('name', 'AbortError');
    await wait(0);
    expect(registry.states()[0].health.status).toBe('unknown');
    expect(registry.diagnostics).toEqual([]);
  });
  it('emits fast results before slow providers and keeps pagination/cache independent', async () => {
    const search = vi.fn(async ({ page }) => ({ items: [card], page, hasMore: true }));
    const registry = new Registry(store(), [
      fakeSource('slow', {
        search: async (input) => {
          await wait(30);
          return { items: [], page: input.page, hasMore: false };
        },
      }),
      fakeSource('fast', { search }),
    ]);
    const events: SearchEvent[] = [];
    await registry.search('星空', {}, new AbortController().signal, (e) => events.push(e));
    expect(events.filter((e) => e.type === 'result').map((e) => e.sourceId)).toEqual(['fast', 'slow']);
    const next: SearchEvent[] = [];
    await registry.search('星空', { fast: 2 }, new AbortController().signal, (e) => next.push(e));
    expect(next.filter((e) => e.type === 'result')).toMatchObject([{ sourceId: 'fast', page: { page: 2 } }]);
    await registry.search('星空', { fast: 2 }, new AbortController().signal, (e) => next.push(e));
    expect(search).toHaveBeenCalledTimes(2);
    expect(next.at(-2)).toMatchObject({ type: 'result', cached: true });
  });
  it('enforces a deadline even for adapters that ignore cancellation', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => controller.signal);
    const registry = new Registry(store(), [
      fakeSource('stuck', { search: () => new Promise(() => {}) }),
      fakeSource('fast'),
    ]);
    const events: SearchEvent[] = [];
    const run = registry.search('x', {}, new AbortController().signal, (e) => events.push(e));
    setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), 25);
    await run;
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', sourceId: 'stuck', code: 'TIMEOUT' }),
    );
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
  it('cancels stale searches without emitting errors or results for them', async () => {
    const controller = new AbortController();
    const events: SearchEvent[] = [];
    const registry = new Registry(store(), [fakeSource('slow', { search: () => new Promise(() => {}) })]);
    const run = registry.search('old', {}, controller.signal, (e) => events.push(e));
    controller.abort();
    await run;
    expect(events).toEqual([{ type: 'source', sourceId: 'slow', status: 'loading' }]);
  });
  it('limits parallelism to three sources and reports all-source failure explicitly', async () => {
    let active = 0,
      peak = 0;
    const registry = new Registry(
      store(),
      Array.from({ length: 6 }, (_, i) =>
        fakeSource(String(i), {
          search: async () => {
            peak = Math.max(peak, ++active);
            await wait(10);
            active--;
            throw new Error('offline');
          },
        }),
      ),
    );
    const events: SearchEvent[] = [];
    await registry.search('x', {}, new AbortController().signal, (e) => events.push(e));
    expect(peak).toBe(3);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(6);
    expect(events.at(-1)?.type).toBe('done');
  });
  it('does not turn failed update checks into a false successful baseline', async () => {
    const s = store();
    s.addLibrary(card, 'watching');
    s.saveSourceSettings('fixture', false, 0);
    const registry = new Registry(s, [fakeSource()]);
    await registry.checkLibrary();
    expect(s.library()[0].checkedAt).toBeUndefined();
    expect(s.library()[0].updateError).toContain('停用');
  });
});

describe('local boundary', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.2',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('blocks non-public address %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each([
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://[::ffff:127.0.0.1]/',
    'file:///etc/passwd',
    'http://test.local/',
    'http://user:secret@example.com',
    'https://example.com:1234/',
  ])('rejects unsafe target %s', (url) => expect(() => validateUrl(url)).toThrow());
  it('accepts ordinary public hosts and enforces source host manifests', () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(validateUrl('https://cdn.example/a?q=1').search).toBe('?q=1');
    expect(() => validateUrl('https://evil.example', ['source.example'])).toThrow('未登记');
  });
  it('rejects unauthorized pages, rebinding hosts and cross-site API requests', async () => {
    const server = await createServer({
      database: ':memory:',
      sources: [fakeSource()],
      token: 'a'.repeat(64),
      updates: false,
    });
    const headers = { host: '127.0.0.1', authorization: `Bearer ${server.token}` };
    try {
      expect(
        (await server.app.inject({ url: '/api/v1/library', headers: { host: '127.0.0.1' } })).statusCode,
      ).toBe(401);
      expect(
        (await server.app.inject({ url: '/api/v1/library', headers: { ...headers, host: 'evil.example' } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await server.app.inject({
            url: '/api/v1/library',
            headers: { ...headers, origin: 'https://evil.example' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await server.app.inject({
            url: '/api/v1/library',
            headers: { ...headers, 'sec-fetch-site': 'cross-site' },
          })
        ).statusCode,
      ).toBe(403);
      expect((await server.app.inject({ url: '/api/v1/library', headers })).statusCode).toBe(200);
      const boot = await server.app.inject({
        url: '/bootstrap?token=' + server.token,
        headers: { host: '127.0.0.1' },
      });
      expect(boot.statusCode).toBe(302);
      expect(boot.headers.location).toBe('/');
      expect(boot.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict');
      expect(boot.headers['set-cookie']).toContain('Max-Age=2592000');
      const badBoot = await server.app.inject({
        url: '/bootstrap?token=expired',
        headers: { host: '127.0.0.1' },
      });
      expect(badBoot.statusCode).toBe(401);
      expect(badBoot.headers['set-cookie']).toBeUndefined();
      expect(
        (
          await server.app.inject({
            url: '/api/v1/library',
            headers: { host: '127.0.0.1', cookie: String(boot.headers['set-cookie']).split(';')[0] },
          })
        ).statusCode,
      ).toBe(200);
      const invalid = await server.app.inject({
        method: 'POST',
        url: '/api/v1/history',
        headers,
        payload: { position: -10 },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await server.app.close();
    }
  });
});

describe('registered media sessions', () => {
  it('keeps an older HLS session active while idle pages exceed the session limit', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const registry = new Registry(store(), [fakeSource()]);
    const gateway = new MediaGateway(registry);
    vi.spyOn(registry.context('fixture').http, 'stream').mockImplementation(async (url) => ({
      url,
      response: response('#EXTM3U\n#EXTINF:4,\n1.ts\n#EXT-X-ENDLIST', {
        'content-type': 'application/vnd.apple.mpegurl',
      }),
    }));
    const playing = await gateway.create(episode(1, 'hls').locator);
    now++;
    const idle = await gateway.create(episode(2, 'hls').locator);
    for (let i = 0; i < 28; i++) {
      now++;
      await gateway.create(episode(3, 'hls').locator);
    }
    now++;
    await gateway.open(playing.sessionId, playing.url.split('/').at(-1)!);
    now++;
    await gateway.create(episode(4, 'hls').locator);
    await expect(gateway.open(playing.sessionId, playing.url.split('/').at(-1)!)).resolves.toMatchObject({
      status: 200,
    });
    await expect(gateway.open(idle.sessionId, idle.url.split('/').at(-1)!)).rejects.toThrow('会话已结束');
  });
  it('detects HLS without a filename extension before choosing the browser playback path', async () => {
    const registry = new Registry(store(), [
      fakeSource('fixture', {
        resolve: async () => ({ url: 'https://cdn.example/play?id=x', format: 'auto' }),
      }),
    ]);
    const gateway = new MediaGateway(registry);
    vi.spyOn(registry.context('fixture').http, 'stream').mockResolvedValue({
      url: 'https://cdn.example/play?id=x',
      response: response('#EXTM3U\n#EXTINF:4,\n1.ts\n#EXT-X-ENDLIST', {
        'content-type': 'application/octet-stream',
      }),
    });
    expect((await gateway.create(episode().locator)).format).toBe('hls');
  });
  it('streams MP4 range responses with upstream request headers and bounded address refresh', async () => {
    const registry = new Registry(store(), [fakeSource()]);
    const gateway = new MediaGateway(registry);
    const stream = vi
      .spyOn(registry.context('fixture').http, 'stream')
      .mockImplementation(async (url, options) => {
        expect(options?.headers?.Range).toBe('bytes=4-7');
        expect(options?.headers?.Referer).toBe('https://provider.example/');
        return {
          url,
          response: response(
            '4567',
            {
              'content-type': 'video/mp4',
              'content-range': 'bytes 4-7/20',
              'content-length': '4',
              'accept-ranges': 'bytes',
            },
            206,
          ),
        };
      });
    const playback = await gateway.create(episode().locator);
    const resource = playback.url.split('/').at(-1)!;
    const result = await gateway.open(playback.sessionId, resource, 'bytes=4-7');
    expect(result.status).toBe(206);
    expect((result.headers as Record<string, string>)['content-range']).toBe('bytes 4-7/20');
    const chunks = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('4567');
    expect(stream).toHaveBeenCalledOnce();
    await expect(gateway.open(playback.sessionId, 'https://example.com')).rejects.toThrow('失效');
    await expect(gateway.open(playback.sessionId, resource, 'bytes=0-1,4-5')).rejects.toThrow('范围');
    expect((await gateway.refresh(playback.sessionId)).refreshed).toBe(true);
    await expect(gateway.refresh(playback.sessionId)).rejects.toThrow('仍无法');
    await expect(gateway.open(playback.sessionId, resource)).rejects.toThrow('失效');
  });
  it('rewrites nested HLS paths against redirected response URLs and blocks private resources', async () => {
    const registry = new Registry(store(), [fakeSource()]);
    const gateway = new MediaGateway(registry);
    const stream = vi.spyOn(registry.context('fixture').http, 'stream');
    stream.mockResolvedValue({
      url: 'https://cdn.example/final/master.m3u8?x=1',
      response: response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nsub/list.m3u8', {
        'content-type': 'application/vnd.apple.mpegurl',
      }),
    });
    const playback = await gateway.create(episode(1, 'hls').locator);
    const master = await gateway.open(playback.sessionId, playback.url.split('/').at(-1)!);
    const child = String(master.body).split('\n').at(-1)!;
    stream.mockImplementation(async (url) => {
      expect(url).toBe('https://cdn.example/final/sub/list.m3u8');
      return {
        url,
        response: response('#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1/secret', {
          'content-type': 'application/vnd.apple.mpegurl',
        }),
      };
    });
    await expect(gateway.open(playback.sessionId, child.split('/').at(-1)!)).rejects.toThrow('本地');
  });
  it('propagates upstream media failures without exposing response bodies or URLs', async () => {
    const registry = new Registry(store(), [fakeSource()]);
    const gateway = new MediaGateway(registry);
    vi.spyOn(registry.context('fixture').http, 'stream').mockResolvedValue({
      url: 'https://cdn.example/token=secret',
      response: response('sensitive body', {}, 403),
    });
    const playback = await gateway.create(episode().locator);
    await expect(gateway.open(playback.sessionId, playback.url.split('/').at(-1)!)).rejects.toThrow('403');
  });
});
