import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { createServer } from '../packages/engine/src/server';
import { card, fakeSource } from './helpers';

const token = 'auth-gate-test-token';
const servers: Awaited<ReturnType<typeof createServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
});

function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('API auth follows the matched route', () => {
  async function listen() {
    const server = await createServer({
      database: ':memory:',
      token,
      updates: false,
      sources: [fakeSource(card.sourceId)],
    });
    servers.push(server);
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    return { server, port: Number(new URL(server.origin()).port) };
  }

  it('rejects unauthenticated API access including encoded aliases', async () => {
    const { port } = await listen();
    expect((await rawRequest(port, '/api/v1/library')).status).toBe(401);
    expect((await rawRequest(port, '/%61pi/v1/library')).status).toBe(401);
    expect((await rawRequest(port, '/%61%70%69/v1/library')).status).toBe(401);
    expect((await rawRequest(port, `http://127.0.0.1:${port}/api/v1/health`)).status).toBe(400);
    const allowed = await rawRequest(port, '/api/v1/library', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(200);
  });

  it('patches source priority without clearing enabled', async () => {
    const { port, server } = await listen();
    expect(server.registry.states().find((source) => source.id === 'fixture')?.enabled).toBe(true);
    const body = JSON.stringify({ priority: 3 });
    const patched = await rawRequest(port, '/api/v1/sources/fixture', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    expect(patched.status).toBe(200);
    const fixture = (JSON.parse(patched.body) as { id: string; enabled: boolean; priority: number }[]).find(
      (source) => source.id === 'fixture',
    );
    expect(fixture?.enabled).toBe(true);
    expect(fixture?.priority).toBe(3);
  });
});
