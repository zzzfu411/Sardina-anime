import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { AppError, publicError } from './errors';
import { Store } from './store';
import { Registry } from './registry';
import { MediaGateway } from './media';
import { BangumiClient, bangumiId } from './bangumi';
import {
  cardSchema,
  historyWriteSchema,
  locatorSchema,
  parse,
  refSchema,
  settingsSchema,
  sourcePreferenceSchema,
  statusSchema,
} from './validation';
import type { AnimeSource } from './sources/types';
import type { AnimeCard, HistoryEntry, LibraryEntry, SourceDetail } from '../../core/src/types';
import { APP_VERSION, BACKUP_MAX_BYTES, episodeKey, refKey } from '../../core/src/types';
import { sourceValidation } from './release';
import { backupFingerprint } from './backups';

export interface ServerOptions {
  database: string;
  token?: string;
  webDir?: string;
  sources?: AnimeSource[];
  updates?: boolean;
  bangumi?: BangumiClient;
  onShutdown?: () => void | Promise<void>;
}
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createServer(options: ServerOptions) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024, requestTimeout: 0 });
  const store = new Store(options.database);
  const registry = new Registry(store, options.sources);
  const media = new MediaGateway(registry);
  const bangumi = options.bangumi ?? new BangumiClient();
  const token = options.token ?? randomBytes(32).toString('hex');
  const cookieName = `rev_${token.slice(0, 12)}`;
  const origin = () => {
    const address = app.server.address();
    return `http://127.0.0.1:${address && typeof address !== 'string' ? address.port : 80}`;
  };
  const presentLibrary = (entries: LibraryEntry[]) =>
    entries.map((e) => ({ ...e, card: media.presentCard(e.card) }));
  const presentDetail = (detail: SourceDetail) => media.presentCard(detail);
  const signal = (reply: { raw: { once: Function; writableEnded: boolean } }) => {
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    return controller.signal;
  };
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      )
      .header('Cache-Control', 'no-store');
    const address = app.server.address();
    const expectedHost = address ? new URL(origin()).host : '127.0.0.1';
    if (req.headers.host !== expectedHost) throw new AppError('INVALID_HOST', '本地服务仅接受本机访问', 403);
    if (req.headers.origin && req.headers.origin !== origin())
      throw new AppError('INVALID_ORIGIN', '不允许其他网页访问本地资料', 403);
    const target = req.raw.url ?? '';
    if (!target.startsWith('/')) throw new AppError('INVALID_TARGET', '不接受绝对形式的请求', 400);
  });
  app.addHook('preHandler', async (req) => {
    if (!req.routeOptions.url?.startsWith('/api/')) return;
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new AppError('INVALID_ORIGIN', '不允许跨站访问', 403);
    const supplied =
      req.headers.cookie
        ?.split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) ?? '';
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!equal(supplied, token) && !equal(bearer, token))
      throw new AppError('UNAUTHORIZED', '请通过应用或启动命令打开本地页面', 401);
  });
  app.setErrorHandler((error, _req, reply) => {
    const safe = publicError(error);
    const status =
      error instanceof AppError
        ? error.status
        : error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
    reply.code(status).send(safe);
  });
  app.get('/bootstrap', async (req, reply) => {
    const supplied = (req.query as { token?: string }).token ?? '';
    if (!equal(supplied, token)) throw new AppError('UNAUTHORIZED', '启动链接已过期，请重新打开应用', 401);
    // Keep the connection across browser restarts; restarting the engine still rotates the token.
    reply
      .header('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`)
      .redirect('/');
  });
  app.get('/api/v1/health', async () => ({
    app: 'revanime',
    version: APP_VERSION,
    pid: process.pid,
    releaseStatus: 'development-preview',
  }));
  app.get('/api/v1/sources', async () => registry.states());
  app.patch('/api/v1/sources/:id', async (req) => {
    const { id } = req.params as { id: string };
    const source = registry.source(id, true);
    const patch = parse(
      z
        .object({
          enabled: z.boolean().optional(),
          priority: z.number().int().min(0).max(99).optional(),
        })
        .refine((value) => value.enabled !== undefined || value.priority !== undefined),
      req.body,
    );
    const current = store.sourceSettings(id, registry.sources.indexOf(source));
    store.saveSourceSettings(id, patch.enabled ?? current.enabled, patch.priority ?? current.priority);
    return registry.states();
  });
  app.get('/api/v1/home', async (req, reply) => {
    const query = parse(z.object({ sourceId: z.string(), refresh: z.string().optional() }), req.query);
    return (await registry.home(query.sourceId, signal(reply), query.refresh === '1')).map((section) => ({
      ...section,
      items: section.items.map((card) => media.presentCard(card)),
    }));
  });
  app.get('/api/v1/catalog', async (req, reply) => {
    const query = parse(
      z.object({
        sourceId: z.string().min(1).max(40),
        page: z.coerce.number().int().min(1).max(1000).default(1),
        cursor: z
          .string()
          .regex(/^\d{1,12}$/)
          .optional(),
        filters: z.string().max(2000).optional(),
        refresh: z.string().optional(),
      }),
      req.query,
    );
    let filters: Record<string, string>;
    try {
      filters = parse(z.record(z.string().max(40), z.string().max(100)), JSON.parse(query.filters ?? '{}'));
    } catch {
      throw new AppError('INVALID_INPUT', '筛选参数无效', 400);
    }
    const result = await registry.catalog(
      query.sourceId,
      { page: query.page, cursor: query.cursor, filters },
      signal(reply),
      query.refresh === '1',
    );
    return { ...result, items: result.items.map((card) => media.presentCard(card)) };
  });
  app.get('/api/v1/schedule', async (req, reply) => {
    const query = parse(
      z.object({
        sourceId: z.string().min(1).max(40),
        weekday: z.coerce.number().int().min(1).max(7),
        refresh: z.string().optional(),
      }),
      req.query,
    );
    const result = await registry.schedule(
      query.sourceId,
      query.weekday,
      signal(reply),
      query.refresh === '1',
    );
    return { ...result, items: result.items.map((card) => media.presentCard(card)) };
  });
  app.get('/api/v1/search-history', async () => store.searchHistory());
  app.delete('/api/v1/search-history', async (req) => {
    const query = parse(z.object({ keyword: z.string().min(1).max(150).optional() }), req.query);
    return store.clearSearchHistory(query.keyword);
  });
  app.get('/api/v1/search', async (req, reply) => {
    const query = parse(
      z.object({
        q: z.string().trim().min(1).max(150),
        sourceId: z.string().min(1).max(40).optional(),
        pages: z.string().max(2000).optional(),
        cursors: z.string().max(2000).optional(),
        refresh: z.string().optional(),
        session: z.string().uuid().optional(),
      }),
      req.query,
    );
    let pages: Record<string, number> = {};
    let cursors: Record<string, string> = {};
    try {
      pages = parse(
        z.record(z.string().max(40), z.number().int().min(1).max(1000)),
        JSON.parse(query.pages ?? '{}'),
      );
      cursors = parse(
        z.record(z.string().max(40), z.string().regex(/^\d{1,12}$/)),
        JSON.parse(query.cursors ?? '{}'),
      );
    } catch {
      throw new AppError('INVALID_INPUT', '搜索分页参数无效', 400);
    }
    const firstPage = !Object.keys(pages).length;
    if (query.sourceId) {
      const source = registry.source(query.sourceId);
      if (!source.manifest.capabilities.includes('search'))
        throw new AppError('UNSUPPORTED', '这个来源不支持关键词搜索', 409);
      if ([...Object.keys(pages), ...Object.keys(cursors)].some((id) => id !== query.sourceId))
        throw new AppError('INVALID_INPUT', '分页参数必须属于当前搜索来源', 400);
      // Explicit source selection also limits first-page requests, not just later pages.
      pages = { [query.sourceId]: pages[query.sourceId] ?? 1 };
    }
    if (firstPage) store.rememberSearch(query.q);
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    reply.raw.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n');
    }, 5000);
    try {
      await registry.search(
        query.q.trim(),
        pages,
        controller.signal,
        (event) => {
          if (reply.raw.destroyed) return;
          if (event.type === 'result')
            event = {
              ...event,
              page: { ...event.page, items: event.page.items.map((card) => media.presentCard(card)) },
            };
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        query.refresh === '1',
        cursors,
        query.session,
      );
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
  });
  const challengeId = (params: unknown) => parse(z.object({ id: z.string().uuid() }), params).id;
  app.get('/api/v1/search/challenges/:id/image', async (req, reply) => {
    const image = registry.searchCaptchaImage(challengeId(req.params));
    return reply.type(image.contentType).send(image.body);
  });
  app.post('/api/v1/search/challenges/:id', async (req, reply) => {
    const { code } = parse(
      z
        .object({
          code: z
            .string()
            .trim()
            .regex(/^\d{4}$/),
        })
        .strict(),
      req.body,
    );
    const result = await registry.submitSearchChallenge(challengeId(req.params), code, signal(reply));
    return result.type === 'result'
      ? {
          ...result,
          page: { ...result.page, items: result.page.items.map((card) => media.presentCard(card)) },
        }
      : result;
  });
  app.post('/api/v1/search/challenges/:id/refresh', async (req, reply) =>
    registry.refreshSearchChallenge(challengeId(req.params), signal(reply)),
  );
  app.delete('/api/v1/search/challenges/:id', async (req) => {
    registry.cancelSearchChallenge(challengeId(req.params));
    return { cancelled: true };
  });
  app.delete('/api/v1/search/sessions/:id', async (req) => {
    registry.cancelSearchSession(challengeId(req.params));
    return { cancelled: true };
  });
  app.get('/api/v1/sources/:id/detail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = parse(
      z.object({ itemId: z.string().min(1).max(200), refresh: z.string().optional() }),
      req.query,
    );
    return presentDetail(
      await registry.detail({ sourceId: id, id: query.itemId }, signal(reply), query.refresh === '1'),
    );
  });
  app.post('/api/v1/playbacks', async (req, reply) =>
    media.create(parse(locatorSchema, req.body), signal(reply)),
  );
  app.get('/api/v1/bangumi/search', async (req, reply) => {
    const query = parse(z.object({ q: z.string().trim().min(1).max(200) }), req.query);
    return bangumi.search(query.q, signal(reply));
  });
  app.get('/api/v1/bangumi/subjects/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: bangumiId }), req.params);
    return bangumi.subject(id, signal(reply));
  });
  app.get('/api/v1/sources/:id/ratings', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = parse(z.object({ itemId: z.string().min(1).max(200) }), req.query);
    const ref = { sourceId: id, id: query.itemId };
    const requestSignal = signal(reply);
    const card = await registry.detail(ref, requestSignal);
    return bangumi.match(
      card,
      store.bangumiLinks().find((link) => refKey(link) === refKey(ref))?.subjectId,
      requestSignal,
    );
  });
  app.put('/api/v1/sources/:id/bangumi', async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ itemId: z.string().min(1).max(200), subjectId: bangumiId }), req.body);
    const ref = { sourceId: id, id: input.itemId };
    const requestSignal = signal(reply);
    await registry.detail(ref, requestSignal);
    const subject = await bangumi.subject(input.subjectId, requestSignal);
    store.linkBangumi(ref, subject.id);
    return { status: 'matched', match: 'manual', subject, candidates: [] };
  });
  app.delete('/api/v1/sources/:id/bangumi', async (req) => {
    const { id } = req.params as { id: string };
    registry.source(id);
    const query = parse(z.object({ itemId: z.string().min(1).max(200) }), req.query);
    store.linkBangumi({ sourceId: id, id: query.itemId });
    return { deleted: true };
  });
  app.post('/api/v1/playback-lines', async (req, reply) =>
    registry.lines(parse(locatorSchema, req.body), signal(reply)),
  );
  app.post('/api/v1/playbacks/:id/refresh', async (req, reply) =>
    media.refresh((req.params as { id: string }).id, signal(reply)),
  );
  const playbackParams = z.object({ id: z.string().uuid() });
  app.get('/api/v1/playbacks/:id/danmaku', async (req, reply) => {
    const { id } = parse(playbackParams, req.params);
    const query = parse(z.object({ refresh: z.enum(['1']).optional() }).strict(), req.query);
    return media.getDanmaku(id, signal(reply), query.refresh === '1');
  });
  app.post('/api/v1/playbacks/:id/audience', async (req) => {
    const { id } = parse(playbackParams, req.params);
    // The browser supplies only a registered playback ID, never an upstream URL.
    if (req.body !== undefined) parse(z.object({}).strict(), req.body);
    return media.openAudience(id);
  });
  app.post('/api/v1/playbacks/:id/audience/close', async (req) => {
    const { id } = parse(playbackParams, req.params);
    await media.closeAudience(id);
    return { closed: true };
  });
  app.delete('/api/v1/playbacks/:id', async (req) => {
    await media.delete((req.params as { id: string }).id);
    return { deleted: true };
  });
  app.get('/api/v1/media/:sessionId/:resourceId', async (req, reply) => {
    const { sessionId, resourceId } = req.params as { sessionId: string; resourceId: string };
    const result = await media.open(sessionId, resourceId, req.headers.range, signal(reply));
    return reply.code(result.status).headers(result.headers).send(result.body);
  });
  app.get('/api/v1/images/:id', async (req, reply) => {
    const result = await media.image((req.params as { id: string }).id, signal(reply));
    return reply
      .header('Content-Type', result.contentType)
      .header('Cache-Control', 'private, max-age=3600')
      .send(result.body);
  });
  app.get('/api/v1/library', async () => presentLibrary(store.library()));
  app.post('/api/v1/library', async (req) => {
    const body = parse(z.object({ card: cardSchema, status: statusSchema }), req.body);
    registry.source(body.card.sourceId, true);
    const entry = store.addLibrary(body.card as AnimeCard, body.status);
    if (options.updates !== false) void registry.checkLibrary(entry.id).catch(() => {});
    return { ...entry, card: media.presentCard(entry.card) };
  });
  app.post('/api/v1/library/link/preview', async (req) => {
    const body = parse(
      z.object({ card: cardSchema, target: cardSchema, libraryId: z.string().min(1).max(100).optional() }),
      req.body,
    );
    registry.source(body.card.sourceId, true);
    registry.source(body.target.sourceId, true);
    const preview = store.previewLibraryLink(body);
    return {
      ...preview,
      base: preview.base ? presentLibrary([preview.base])[0] : null,
      merged: presentLibrary(preview.merged),
    };
  });
  app.post('/api/v1/library/link', async (req) => {
    const { token } = parse(z.object({ token: z.string().uuid() }), req.body);
    return presentLibrary([store.confirmLibraryLink(token)])[0];
  });
  app.post('/api/v1/library/undo', async (req) => {
    const { token } = parse(z.object({ token: z.string().uuid() }), req.body);
    return presentLibrary([store.undoLibrary(token)])[0];
  });
  app.patch('/api/v1/library/:id', async (req) => {
    const patch = parse(
      z.object({
        status: statusSchema.optional(),
        ref: refSchema.optional(),
        unlinkRef: refSchema.optional(),
        markSeen: z.boolean().optional(),
        revision: z.string().min(1).max(100).optional(),
      }),
      req.body,
    );
    if (patch.ref) registry.source(patch.ref.sourceId, true);
    const entry = store.updateLibrary((req.params as { id: string }).id, patch);
    return { ...entry, card: media.presentCard(entry.card) };
  });
  app.delete('/api/v1/library/:id', async (req) => {
    return store.removeLibraryWithUndo((req.params as { id: string }).id);
  });
  app.get('/api/v1/library/check/status', async () => registry.libraryCheckStatus());
  app.post('/api/v1/library/check/start', async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(100).optional() }), req.body ?? {});
    return registry.startLibraryCheck(id);
  });
  let updating: Promise<unknown> | undefined;
  app.post('/api/v1/library/check', async () => {
    updating ??= registry.checkLibrary().finally(() => {
      updating = undefined;
    });
    await updating;
    return presentLibrary(store.library());
  });
  const historyRefs = (value?: string) => {
    if (value === undefined) return undefined;
    try {
      return parse(z.array(refSchema).min(1).max(30), JSON.parse(value));
    } catch {
      throw new AppError('INVALID_INPUT', '番剧记录范围无效', 400);
    }
  };
  const presentHistory = (entry: HistoryEntry) => ({ ...entry, card: media.presentCard(entry.card) });
  app.get('/api/v1/history/recent', async () => store.historyData.recent().map(presentHistory));
  app.get('/api/v1/history/entry', async (req) => {
    const locator = parse(locatorSchema, req.query);
    const entry = store.historyByKey(episodeKey(locator));
    return { entry: entry ? presentHistory(entry) : null, version: store.historyData.version(locator) };
  });
  app.get('/api/v1/history/page', async (req) => {
    const query = parse(
      z.object({
        q: z.string().max(150).optional(),
        refs: z.string().max(12000).optional(),
        cursor: z.string().max(2000).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const result = store.historyData.page({
      query: query.q,
      refs: historyRefs(query.refs),
      cursor: query.cursor,
      limit: query.limit,
    });
    return { ...result, items: result.items.map(presentHistory) };
  });
  app.get('/api/v1/history', async (req) => {
    const query = parse(
      z.object({ key: z.string().min(1).max(1000).optional(), refs: z.string().max(12000).optional() }),
      req.query,
    );
    if (query.key !== undefined) {
      const entry = store.historyByKey(query.key);
      return { entry: entry ? { ...entry, card: media.presentCard(entry.card) } : null };
    }
    const refs = historyRefs(query.refs);
    return (refs ? store.historyData.related(refs) : store.history()).map(presentHistory);
  });
  app.post('/api/v1/history', async (req) =>
    presentHistory(store.saveHistory(parse(historyWriteSchema, req.body))),
  );
  app.delete('/api/v1/history', async (req) => {
    const query = parse(
      z
        .object({ key: z.string().min(1).max(1000).optional(), refs: z.string().max(12000).optional() })
        .refine((value) => !(value.key && value.refs)),
      req.query,
    );
    const selection = { key: query.key, refs: historyRefs(query.refs) };
    const count = store.historyData.delete(selection);
    return { deleted: true, count, boundary: store.historyData.boundary(selection) };
  });
  app.get('/api/v1/settings', async () => store.settings());
  app.put('/api/v1/settings', async (req) => store.saveSettings(parse(settingsSchema, req.body)));
  app.patch('/api/v1/settings/source-preferences', async (req) => {
    const { module, sourceId, generation } = parse(sourcePreferenceSchema, req.body);
    if (!registry.source(sourceId, true).manifest.capabilities.includes(module))
      throw new AppError('UNSUPPORTED_SOURCE', '这个来源不支持当前模块', 400);
    return store.saveSourcePreference(module, sourceId, generation);
  });
  app.get('/api/v1/backup', async (_req, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="sardina-anime-backup.json"')
      .send(store.export()),
  );
  app.post('/api/v1/backup/preview', { bodyLimit: BACKUP_MAX_BYTES }, async (req) =>
    store.previewBackup(req.body),
  );
  app.get('/api/v1/backup/files', async () => store.backups.list());
  app.get('/api/v1/backup/files/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const { data } = store.backups.read(name);
    return reply.header('Content-Disposition', `attachment; filename="${name}"`).send(data);
  });
  app.post('/api/v1/backup/files/:name/preview', async (req) =>
    store.previewBackup(store.backups.read((req.params as { name: string }).name).data),
  );
  const restoreBackup = (input: unknown) => {
    const result = store.restore(input);
    registry.resetLibraryCheck();
    registry.clearCache();
    bangumi.clearCache();
    return result;
  };
  app.post('/api/v1/backup/files/:name/restore', async (req) => {
    const { fingerprint } = parse(
      z.object({
        fingerprint: z
          .string()
          .regex(/^[a-f\d]{64}$/)
          .optional(),
      }),
      req.body ?? {},
    );
    const { data } = store.backups.read((req.params as { name: string }).name);
    if (fingerprint && fingerprint !== backupFingerprint(data))
      throw new AppError('BACKUP_CHANGED', '备份内容已变化，请重新预览后恢复', 409);
    return restoreBackup(data);
  });
  app.post('/api/v1/backup/restore', { bodyLimit: BACKUP_MAX_BYTES }, async (req) => restoreBackup(req.body));
  app.post('/api/v1/shutdown', async (_req, reply) => {
    await reply.send({ shuttingDown: true });
    setImmediate(() => {
      void options.onShutdown?.();
    });
  });
  app.post('/api/v1/cache/clear', async () => {
    media.clearCache();
    registry.clearCache();
    bangumi.clearCache();
    return { cleared: true };
  });
  app.get('/api/v1/diagnostics', async () => ({
    releaseStatus: 'development-preview',
    sources: registry.states(),
    validation: sourceValidation,
    events: registry.diagnostics.slice().reverse(),
  }));
  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir, index: ['index.html'], dotfiles: 'deny' });
    app.setNotFoundHandler((req, reply) => {
      const rawPath = (req.raw.url ?? '').split('?')[0] ?? '';
      let pathname = rawPath;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        /* malformed percent-encoding */
      }
      return pathname.startsWith('/api/')
        ? reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' })
        : reply.sendFile('index.html');
    });
  }
  const refresh = () => {
    updating ??= registry.checkLibrary().finally(() => {
      updating = undefined;
    });
    void updating.catch(() => {});
  };
  const timer = options.updates === false ? undefined : setInterval(refresh, 60 * 60_000);
  timer?.unref();
  if (options.updates !== false)
    app.addHook('onListen', async () => {
      refresh();
    });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await media.close();
    registry.close();
    bangumi.close();
    store.close();
  });
  return { app, store, registry, media, bangumi, token, origin };
}
