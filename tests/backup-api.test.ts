import { expect, it } from 'vitest';
import { BACKUP_MAX_BYTES, episodeKey } from '../packages/core/src/types';
import { createServer } from '../packages/engine/src/server';
import { card, episode, fakeSource } from './helpers';

it('restores an exported backup above the old 16 MiB request limit', async () => {
  const server = await createServer({
    database: ':memory:',
    token: 'backup-fixture-token',
    sources: [fakeSource()],
    updates: false,
  });
  const headers = { host: '127.0.0.1', authorization: 'Bearer backup-fixture-token' };
  try {
    const backup = server.store.export();
    const timestamp = '2026-06-01T00:00:00.000Z';
    const entries = Array.from({ length: 600 }, (_, index) => {
      const item = episode(index + 1);
      return {
        key: episodeKey(item.locator),
        card: { ...card, description: '番'.repeat(10000) },
        episode: item,
        position: index,
        duration: 1000,
        capturedAt: timestamp,
        updatedAt: timestamp,
      };
    });
    server.store.restore({ ...backup, history: entries });
    const exported = await server.app.inject({ url: '/api/v1/backup', headers });
    expect(exported.statusCode).toBe(200);
    expect(Buffer.byteLength(exported.body)).toBeGreaterThan(16 * 1024 * 1024);
    expect(Buffer.byteLength(exported.body)).toBeLessThan(BACKUP_MAX_BYTES);
    server.store.clearHistory();
    const restored = await server.app.inject({
      method: 'POST',
      url: '/api/v1/backup/restore',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: exported.body,
    });
    expect(restored.statusCode).toBe(200);
    expect(server.store.history()).toHaveLength(entries.length);
    expect(server.store.historyByKey(entries[599].key)?.position).toBe(599);
  } finally {
    await server.app.close();
  }
});
