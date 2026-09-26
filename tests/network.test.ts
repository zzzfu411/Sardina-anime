import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../packages/engine/src/http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { response } from './helpers';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
const dns = vi.mocked(lookup);
const originalProxy = [
  process.env.HTTPS_PROXY,
  process.env.https_proxy,
  process.env.HTTP_PROXY,
  process.env.http_proxy,
];
function direct() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];
}
afterEach(() => {
  vi.restoreAllMocks();
  ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].forEach((key, i) => {
    if (originalProxy[i] === undefined) delete process.env[key];
    else process.env[key] = originalProxy[i];
  });
});
function transport(handler: (url: URL, options: any, callback: Function) => void) {
  return vi.spyOn(https, 'request').mockImplementation(((url: URL, options: any, callback: Function) => {
    const req = Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => handler(url, options, callback)),
      destroy: (error: Error) => req.emit('error', error),
    });
    return req;
  }) as unknown as typeof https.request);
}

describe('network destination enforcement', () => {
  it('reuses metadata proxy tunnels only for the same checked IP and still rejects changed private DNS', async () => {
    direct();
    process.env.HTTPS_PROXY = 'http://proxy.example:8080';
    dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    const agents: HttpsProxyAgent<string>[] = [];
    const connect = vi.spyOn(HttpsProxyAgent.prototype, 'connect').mockResolvedValue({} as never);
    transport((_url, options, callback) => {
      agents.push(options.agent);
      callback(response('ok'));
    });
    const client = new HttpClient();
    try {
      await client.text('https://source.example/first');
      await client.text('https://source.example/second');
      expect(agents[0]).toBe(agents[1]);
      expect(agents[0].keepAlive).toBe(true);
      dns.mockResolvedValue([{ address: '1.0.0.1', family: 4 }] as never);
      await client.text('https://source.example/third');
      expect(agents[2]).not.toBe(agents[0]);
      await agents[2].connect(
        {} as never,
        { host: 'source.example', port: 443, secureEndpoint: true } as never,
      );
      expect(connect.mock.calls[0][1]).toMatchObject({ host: '1.0.0.1', servername: 'source.example' });
      dns.mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
      await expect(client.text('https://source.example/private')).rejects.toThrow('本地');
      expect(agents).toHaveLength(3);
    } finally {
      client.close();
    }
  });
  it('carries an adapter CDN port exception through redirects but still checks its DNS', async () => {
    direct();
    dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    transport((url, _options, callback) => {
      callback(
        url.hostname === 'source.example'
          ? response('', { location: 'https://cdn.example:30443/video' }, 302)
          : response('video', { 'content-type': 'video/mp4' }),
      );
    });
    const client = new HttpClient();
    const options = { allowedPortOrigins: ['https://cdn.example:30443'] };
    expect((await client.bytes('https://source.example/start', options)).body.toString()).toBe('video');
    dns.mockImplementation(async (host) =>
      host === 'cdn.example'
        ? ([{ address: '10.0.0.1', family: 4 }] as never)
        : ([{ address: '1.1.1.1', family: 4 }] as never),
    );
    await expect(client.bytes('https://source.example/start', options)).rejects.toThrow('本地');
  });
  it('rejects mixed public/private DNS results before opening any socket', async () => {
    direct();
    dns.mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ] as never);
    const request = transport(() => {
      throw new Error('should not connect');
    });
    await expect(new HttpClient().stream('https://cdn.example/video')).rejects.toThrow('本地');
    expect(request).not.toHaveBeenCalled();
  });
  it('pins the checked DNS address and blocks redirects to a private target', async () => {
    direct();
    dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    const request = transport((_url, options, callback) => {
      options.lookup('cdn.example', { all: true }, (error: unknown, addresses: unknown) => {
        expect(error).toBeNull();
        expect(addresses).toEqual([{ address: '1.1.1.1', family: 4 }]);
      });
      callback(response('', { location: 'http://169.254.169.254/latest/meta-data/' }, 302));
    });
    await expect(new HttpClient().stream('https://cdn.example/start')).rejects.toThrow('本地');
    expect(request).toHaveBeenCalledOnce();
  });
  it('revalidates redirected hosts, preserves per-host cookies and drops cross-host credentials', async () => {
    direct();
    dns.mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    let calls = 0;
    transport((url, options, callback) => {
      if (calls++ === 0) callback(response('', { location: 'https://final.example/video' }, 302));
      else {
        expect(url.hostname).toBe('final.example');
        expect(options.headers.Authorization).toBeUndefined();
        expect(options.headers.Cookie).toBe('destination=yes');
        callback(response('media', { 'content-type': 'video/mp4' }));
      }
    });
    const client = new HttpClient();
    await client.jar.setCookie('destination=yes; Secure', 'https://final.example/');
    const result = await client.bytes('https://source.example/a', {
      headers: { Authorization: 'Bearer secret', Cookie: 'source=secret' },
    });
    expect(result.url).toBe('https://final.example/video');
    expect(result.body.toString()).toBe('media');
    expect(dns).toHaveBeenCalledWith('final.example', { all: true });
  });
});
