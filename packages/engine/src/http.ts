import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CookieJar } from 'tough-cookie';
import ipaddr from 'ipaddr.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AppError } from './errors';

export interface HttpOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
  method?: 'GET' | 'POST' | 'HEAD';
  body?: string;
  allowedHosts?: string[];
  /** Exact, adapter-declared origins allowed to use nonstandard public ports. */
  allowedPortOrigins?: string[];
  /** Buffered API/page/image reads may reuse a checked proxy connection. */
  reuseConnection?: boolean;
}
export interface HttpResponse {
  response: IncomingMessage;
  url: string;
}

export function isPublicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}

export function validateUrl(raw: string, allowedHosts?: string[], allowedPortOrigins: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_URL', '来源返回了无效地址');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443', '8443'].includes(url.port) && !allowedPortOrigins.includes(url.origin))
  ) {
    throw new AppError('BLOCKED_URL', '来源地址不符合访问规则');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new AppError('BLOCKED_ADDRESS', '禁止访问本地或保留网络地址');
  if (allowedHosts && !allowedHosts.includes(host))
    throw new AppError('BLOCKED_HOST', '来源跳转到了未登记的站点');
  return url;
}

export class HttpClient {
  readonly jar = new CookieJar();
  private proxyAgents = new Map<string, HttpsProxyAgent<string>>();
  constructor(
    private defaults: Record<string, string> = { 'User-Agent': 'Revanime/0.1 (+local anime player)' },
  ) {}

  close() {
    for (const agent of this.proxyAgents.values()) agent.destroy();
    this.proxyAgents.clear();
  }

  private proxyAgent(proxy: string, url: URL, address: string, reuse: boolean) {
    // A new DNS answer gets a different pool; no socket can bypass the checked IP.
    const key = `${proxy}|${url.origin}|${address}`;
    const cached = reuse ? this.proxyAgents.get(key) : undefined;
    if (cached) {
      this.proxyAgents.delete(key);
      this.proxyAgents.set(key, cached);
      return cached;
    }
    if (reuse && this.proxyAgents.size >= 32) {
      const idle = [...this.proxyAgents].find(([, agent]) =>
        [...Object.values(agent.sockets), ...Object.values(agent.requests)].every((list) => !list?.length),
      );
      if (idle) {
        idle[1].destroy();
        this.proxyAgents.delete(idle[0]);
      } else reuse = false; // Do not evict an active connection to make space.
    }
    const agent = new HttpsProxyAgent(proxy, {
      keepAlive: reuse,
      maxSockets: 6,
      maxFreeSockets: 2,
      timeout: 10_000,
    });
    const connect = agent.connect.bind(agent);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    agent.connect = (req, opts) =>
      connect(
        req,
        opts.secureEndpoint ? { ...opts, host: address, servername: host } : { ...opts, host: address },
      );
    if (reuse) this.proxyAgents.set(key, agent);
    return agent;
  }

  async stream(raw: string, options: HttpOptions = {}, depth = 0): Promise<HttpResponse> {
    if (depth > 5) throw new AppError('REDIRECT_LIMIT', '来源重定向次数过多');
    const url = validateUrl(raw, options.allowedHosts, options.allowedPortOrigins);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    if (!records.length || records.some((record) => !isPublicAddress(record.address)))
      throw new AppError('BLOCKED_ADDRESS', '禁止访问本地或保留网络地址');
    options.signal?.throwIfAborted();
    const chosen = records.find((r) => r.family === 4) ?? records[0];
    const proxy =
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    const agent = proxy
      ? this.proxyAgent(proxy, url, chosen.address, options.reuseConnection === true)
      : undefined;
    const cookie = await this.jar.getCookieString(url.href);
    const headers: Record<string, string> = {
      ...this.defaults,
      ...options.headers,
      'Accept-Encoding': 'identity',
    };
    if (cookie) headers.Cookie = cookie;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(
        url,
        {
          method: options.method ?? 'GET',
          headers,
          signal: options.signal,
          agent,
          lookup: (_hostname, opts, callback) => {
            // DNS is resolved and checked before connecting; the actual socket uses that pinned address.
            if (typeof opts === 'object' && opts.all) (callback as Function)(null, [chosen]);
            else (callback as Function)(null, chosen.address, chosen.family);
          },
        },
        (res) => {
          clearTimeout(timer);
          res.setTimeout(30_000, () => res.destroy(new AppError('TIMEOUT', '媒体服务器长时间没有响应')));
          resolve(res);
        },
      );
      const timer = setTimeout(
        () => req.destroy(new AppError('TIMEOUT', '来源响应超时')),
        options.timeout ?? 15_000,
      );
      timer.unref();
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.end(options.body);
    });
    for (const value of response.headers['set-cookie'] ?? []) {
      await this.jar.setCookie(value, url.href, { ignoreError: true });
    }
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
      response.resume();
      const next = new URL(response.headers.location, url);
      const redirectHeaders = { ...options.headers };
      if (next.origin !== url.origin) {
        for (const key of Object.keys(redirectHeaders))
          if (/^(authorization|cookie|origin)$/i.test(key)) delete redirectHeaders[key];
      }
      const changeMethod =
        response.statusCode === 303 ||
        ([301, 302].includes(response.statusCode!) && options.method === 'POST');
      return this.stream(
        next.href,
        { ...options, headers: redirectHeaders, ...(changeMethod ? { method: 'GET', body: undefined } : {}) },
        depth + 1,
      );
    }
    return { response, url: url.href };
  }

  async bytes(
    raw: string,
    options: HttpOptions = {},
    maxBytes = 8 * 1024 * 1024,
  ): Promise<{ body: Buffer; url: string; contentType: string }> {
    const { response, url } = await this.stream(raw, { ...options, reuseConnection: true });
    const status = response.statusCode ?? 500;
    if (status >= 400) {
      response.destroy();
      throw new AppError(
        [401, 403, 429].includes(status) ? 'ACCESS_REQUIRED' : 'UPSTREAM_HTTP',
        [401, 403, 429].includes(status)
          ? `来源限制了访问（${status}），请稍后重试`
          : `来源服务器返回 ${status}`,
      );
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > maxBytes) {
        response.destroy();
        throw new AppError('RESPONSE_TOO_LARGE', '来源响应超过大小限制');
      }
      chunks.push(data);
    }
    const body = Buffer.concat(chunks);
    const contentType = String(response.headers['content-type'] ?? '');
    if (
      contentType.includes('html') &&
      /Just a moment|challenge-platform|<title>身份验证/i.test(body.toString('utf8'))
    ) {
      throw new AppError('ACCESS_REQUIRED', '来源需要浏览器验证，当前线路暂不支持');
    }
    return { body, url, contentType };
  }
  async text(raw: string, options: HttpOptions = {}) {
    return (await this.bytes(raw, options)).body.toString('utf8');
  }
  async json<T = unknown>(raw: string, options: HttpOptions = {}): Promise<T> {
    try {
      return JSON.parse(await this.text(raw, options)) as T;
    } catch (error) {
      if (error instanceof SyntaxError) throw new AppError('INVALID_RESPONSE', '来源返回的数据格式已变化');
      throw error;
    }
  }
}
