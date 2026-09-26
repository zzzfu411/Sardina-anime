// Only the test harness installs this in-memory transport. Production never allows localhost media targets.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../packages/engine/src/server';
import { discoverySource, fakeSource, response } from './helpers';
import { AppError } from '../packages/engine/src/errors';
import { captchaSource } from './captcha-fixture';

const token = 'e2e-fixture-token';
const source = discoverySource();
const socialCalls = { reads: 0, joins: 0, leaves: 0 };
source.manifest.capabilities.push('danmaku', 'audience');
source.getDanmaku = async () => {
  socialCalls.reads++;
  return {
    comments: [
      { id: '1', time: 0.5, mode: 'scroll', color: '#ffffff', text: '星空放映室 · 弹幕测试' },
      { id: '2', time: 2, mode: 'top', color: '#ffe198', text: '顶部弹幕：暂停与进度同步' },
      { id: '3', time: 4, mode: 'bottom', color: '#a9e5e0', text: '字幕区域会留出空间' },
      { id: '4', time: 9, mode: 'scroll', color: '#ffffff', text: '拖动进度后继续同步' },
      { id: '5', time: 12, mode: 'top', color: '#ffffff', text: '<img onerror=alert(1)>只是文字' },
    ],
    total: 5,
    truncated: false,
    fetchedAt: new Date().toISOString(),
  };
};
source.updateAudience = async (_media, action) => {
  if (action === 'open') socialCalls.joins++;
  else socialCalls.leaves++;
  return { count: 8, scope: 'episode-line', sampledAt: new Date().toISOString() };
};
const originalDetail = source.getDetail;
source.getDetail = async (ref, ctx) => ({
  ...(await originalDetail(ref, ctx)),
  ...(ref.id === 'one' ? { externalIds: { bangumi: '42' } } : {}),
  ratings: [{ label: '测试来源 站内', score: 7.1, origin: 'source' }],
});
const broken = fakeSource('offline', {
  search: async () => {
    throw new AppError('ACCESS_REQUIRED', '测试来源暂时受限');
  },
  getHome: async () => [],
});
const server = await createServer({
  database: process.env.E2E_DATABASE ?? '.cache/e2e/revanime.sqlite',
  token,
  sources: [source, broken, ...(process.env.E2E_CAPTCHA === '1' ? [captchaSource('girigiri')] : [])],
  webDir: resolve('dist/web'),
  updates: false,
});
server.app.get('/api/v1/test/playback-social', async () => ({ ...socialCalls }));
server.bangumi.http.json = async <T>(url: string): Promise<T> => {
  const id = url.endsWith('/43') ? 43 : 42;
  const subject = {
    id,
    type: 2,
    name: id === 42 ? 'Stars' : 'Stars II',
    name_cn: id === 42 ? '星空放映室' : '星空放映室 第二季',
    date: '2026-07-01',
    platform: 'TV',
    infobox: [],
    rating: { score: 8.2, total: 512, rank: 130 },
  };
  return (url.includes('/search/') ? { total: 1, data: [subject] } : subject) as T;
};
server.app.addHook('onResponse', async (req, reply) => {
  if (req.url.startsWith('/api/v1/media/') && reply.statusCode >= 400)
    console.log(
      'media-test',
      JSON.stringify({
        status: reply.statusCode,
        cookie: Boolean(req.headers.cookie),
        origin: req.headers.origin,
        site: req.headers['sec-fetch-site'],
        agent: req.headers['user-agent']?.slice(0, 90),
      }),
    );
});
server.app.get('/safari-check', async (_req, reply) =>
  reply.type('text/html').send(await readFile('tests/safari-check.html', 'utf8')),
);
server.app.get('/safari-check.js', async (_req, reply) =>
  reply.type('application/javascript').send(await readFile('tests/safari-check.js', 'utf8')),
);
server.app.post('/api/v1/test/safari-result', async (req) => {
  await writeFile('docs/validation/safari.json', JSON.stringify(req.body, null, 2) + '\n');
  return { saved: true };
});
server.registry.context('fixture').http.stream = async (url, options) => {
  const name = new URL(url).pathname.split('/').at(-1)!;
  if (!/^(sample\.mp4|index\.m3u8|segment-\d\d\.ts|poster\.png)$/.test(name))
    throw new Error('Unknown fixture resource');
  const buffer = await readFile(resolve('tests/fixtures/media', name));
  const type = name.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : name.endsWith('.mp4')
      ? 'video/mp4'
      : name.endsWith('.ts')
        ? 'video/mp2t'
        : 'image/png';
  const range = options?.headers?.Range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && name.endsWith('.mp4')) {
    const start = range[1] ? Number(range[1]) : Math.max(0, buffer.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(buffer.length - 1, Number(range[2])) : buffer.length - 1;
    return {
      url,
      response: response(
        buffer.subarray(start, end + 1),
        {
          'content-type': type,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${buffer.length}`,
          'accept-ranges': 'bytes',
        },
        206,
      ),
    };
  }
  return {
    url,
    response: response(buffer, {
      'content-type': type,
      'content-length': String(buffer.length),
      'accept-ranges': 'bytes',
    }),
  };
};
const port = Number(process.env.E2E_PORT ?? 4179);
if (process.env.E2E_CAPTCHA === '1')
  server.registry.context('girigiri').http.stream = server.registry.context('fixture').http.stream;
await server.app.listen({ host: '127.0.0.1', port });
console.log(`Fixture app ready at http://127.0.0.1:${port}`);
const stop = async () => {
  server.app.server.closeAllConnections();
  await server.app.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
