// Opt-in live comparison; requests public catalog data only, with an isolated in-memory profile.
import { writeFile } from 'node:fs/promises';
import { createServer } from '../packages/engine/src/server';
import { APP_VERSION } from '../packages/core/src/types';

const server = await createServer({ database: ':memory:', updates: false });
const upstream: string[] = [];
const http = server.registry.context('girigiri').http;
const read = http.text.bind(http);
http.text = async (url, options) => {
  upstream.push(new URL(url).pathname);
  return read(url, options);
};
const results: Record<string, unknown>[] = [];
await server.app.listen({ host: '127.0.0.1', port: 0 });
const request = async (path: string) => {
  const response = await fetch(server.origin() + '/api/v1' + path, {
    headers: { Authorization: `Bearer ${server.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.code}`);
  return body;
};
const measure = async (name: string, paths: string[]) => {
  const offset = upstream.length,
    began = performance.now();
  try {
    const data = await Promise.all(paths.map(request));
    const result = {
      name,
      ms: Math.round(performance.now() - began),
      upstreamReads: upstream.length - offset,
      items: data.map((d) => d.items?.length ?? d[0]?.items?.length),
      ok: true,
    };
    results.push(result);
    console.log(result);
  } catch (error) {
    const result = { name, ms: Math.round(performance.now() - began), ok: false, error: String(error) };
    results.push(result);
    console.log(result);
  }
};
try {
  for (const [name, path] of [
    ['home', '/home?sourceId=girigiri&refresh=1'],
    ['catalog', '/catalog?sourceId=girigiri&page=1&refresh=1'],
    ['detail', '/sources/girigiri/detail?itemId=27100&refresh=1'],
    ['schedule', '/schedule?sourceId=girigiri&weekday=3&refresh=1'],
  ])
    await measure(name, [path]);
  server.registry.clearCache();
  await measure('home-and-schedule-shared', [
    '/home?sourceId=girigiri',
    '/schedule?sourceId=girigiri&weekday=3',
  ]);
  await measure('switch-weekdays', [
    '/schedule?sourceId=girigiri&weekday=1',
    '/schedule?sourceId=girigiri&weekday=2',
  ]);
  await measure('catalog-three-windows', Array(3).fill('/catalog?sourceId=girigiri&page=1'));
  await measure('catalog-cached', ['/catalog?sourceId=girigiri&page=1']);
  await measure('schedule-manual-refresh', ['/schedule?sourceId=girigiri&weekday=3&refresh=1']);
  await writeFile(
    'docs/validation/performance-after.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), version: APP_VERSION, results }, null, 2) + '\n',
  );
} finally {
  server.app.server.closeAllConnections();
  await server.app.close();
}
