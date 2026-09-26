import { randomUUID } from 'node:crypto';
import type { SearchChallenge, SearchContinuation, SearchInput } from '../../core/src/types';
import { AppError, SearchChallengeError, abortable } from './errors';
import { HttpClient } from './http';
import type { AnimeSource, SourceContext } from './sources/types';

interface Session {
  owner: string;
  source: AnimeSource;
  input: SearchInput;
  http: HttpClient;
  expires: number;
  controller?: AbortController;
  challenge?: SearchChallenge;
  image?: { body: Buffer; contentType: string };
}

/** One cookie jar per search page, reused for its pagination, never shared with another window. */
export class SearchChallenges {
  private sessions = new Map<string, Session>();
  private challenges = new Map<string, Session>();
  private timer = setInterval(() => this.prune(), 60_000);
  private readonly sessionTTL = 15 * 60_000;
  private readonly challengeTTL = 5 * 60_000;

  constructor() {
    this.timer.unref();
  }

  private key(owner: string, sourceId: string) {
    return `${owner}:${sourceId}`;
  }
  private forgetImage(session: Session) {
    if (session.challenge) this.challenges.delete(session.challenge.id);
    delete session.challenge;
    delete session.image;
  }
  private remove(session: Session) {
    session.controller?.abort();
    this.forgetImage(session);
    session.http.close();
    this.sessions.delete(this.key(session.owner, session.source.manifest.id));
  }
  private prune() {
    for (const session of this.sessions.values()) {
      if (session.expires <= Date.now()) this.remove(session);
      else if (session.challenge && Date.parse(session.challenge.expiresAt) <= Date.now())
        this.forgetImage(session);
    }
  }
  clear() {
    for (const session of this.sessions.values()) this.remove(session);
  }
  close() {
    clearInterval(this.timer);
    this.clear();
  }
  cancel(owner: string) {
    for (const session of this.sessions.values()) if (session.owner === owner) this.remove(session);
  }
  cancelChallenge(id: string) {
    const session = this.challenges.get(id);
    if (session) this.remove(session);
  }
  private get(id: string) {
    this.prune();
    const session = this.challenges.get(id);
    if (!session) throw new AppError('CAPTCHA_EXPIRED', '验证码已过期，请重新搜索此来源。', 410);
    return session;
  }
  image(id: string) {
    return this.get(id).image!;
  }
  sourceId(id: string) {
    return this.get(id).source.manifest.id;
  }

  private async operation<T>(
    session: Session,
    signal: AbortSignal | undefined,
    read: (ctx: SourceContext) => Promise<T>,
  ) {
    if (session.controller) throw new AppError('CAPTCHA_BUSY', '正在处理这次验证，请稍候。', 409);
    const controller = new AbortController();
    session.controller = controller;
    const combined = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
      ...(signal ? [signal] : []),
    ]);
    const ctx = { http: session.http, signal: combined };
    try {
      combined.throwIfAborted();
      const result = await abortable(read(ctx), combined);
      combined.throwIfAborted();
      session.expires = Date.now() + this.sessionTTL;
      return result;
    } finally {
      if (session.controller === controller) delete session.controller;
    }
  }

  private async picture(
    session: Session,
    ctx: SourceContext,
    message = '请输入图片中的 4 位数字，继续搜索。',
  ) {
    // Invalidate the old picture before fetching: the upstream also replaces its code at this point.
    this.forgetImage(session);
    const image = await session.source.getSearchCaptcha!(ctx);
    ctx.signal?.throwIfAborted();
    if (this.sessions.get(this.key(session.owner, session.source.manifest.id)) !== session)
      throw new DOMException('Search cancelled', 'AbortError');
    if (
      !/^image\/(png|jpeg|gif|webp)$/.test(image.contentType) ||
      image.body.length > 256 * 1024 ||
      !image.body.length
    )
      throw new AppError('INVALID_CAPTCHA', '验证码图片未能加载，请重新搜索此来源。');
    const id = randomUUID();
    const challenge: SearchChallenge = {
      id,
      sourceId: session.source.manifest.id,
      imageUrl: `/api/v1/search/challenges/${id}/image`,
      expiresAt: new Date(Date.now() + this.challengeTTL).toISOString(),
      message,
      digits: 4,
    };
    session.image = image;
    session.challenge = challenge;
    this.challenges.set(id, session);
    return challenge;
  }

  async search(source: AnimeSource, input: SearchInput, owner: string, signal?: AbortSignal) {
    this.prune();
    const key = this.key(owner, source.manifest.id);
    let session = this.sessions.get(key);
    if (session && session.input.keyword !== input.keyword)
      throw new AppError('INVALID_SEARCH_SESSION', '搜索词已变化，请重新搜索。', 409);
    if (!session) {
      if (this.sessions.size >= 32)
        throw new AppError('SEARCH_LIMIT', '打开的搜索过多，请关闭其他搜索页后重试。', 429);
      session = {
        owner,
        source,
        input: { ...input },
        http: new HttpClient(),
        expires: Date.now() + this.sessionTTL,
      };
      this.sessions.set(key, session);
    }
    const current = session;
    let challenge: SearchChallenge | undefined;
    const result = await this.operation(current, signal, async (ctx) => {
      current.input = { ...input };
      this.forgetImage(current);
      try {
        return await source.search(input, ctx);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'CAPTCHA_REQUIRED') throw error;
        challenge = await this.picture(current, ctx);
      }
    });
    if (challenge) throw new SearchChallengeError(challenge);
    return result!;
  }

  async refresh(id: string, signal?: AbortSignal): Promise<SearchContinuation> {
    const session = this.get(id);
    const challenge = await this.operation(session, signal, (ctx) => this.picture(session, ctx));
    return { type: 'challenge', sourceId: session.source.manifest.id, challenge };
  }

  async submit(id: string, code: string, signal?: AbortSignal): Promise<SearchContinuation> {
    if (!/^\d{4}$/.test(code)) throw new AppError('INVALID_CAPTCHA_CODE', '请输入 4 位数字。', 400);
    const session = this.get(id);
    return this.operation(session, signal, async (ctx) => {
      try {
        await session.source.submitSearchCaptcha!(code, ctx);
        const page = await session.source.search(session.input, ctx);
        ctx.signal?.throwIfAborted();
        this.forgetImage(session);
        return { type: 'result', sourceId: session.source.manifest.id, page, cached: false };
      } catch (error) {
        if (!(error instanceof AppError) || !['CAPTCHA_INCORRECT', 'CAPTCHA_REQUIRED'].includes(error.code))
          throw error;
        const challenge = await this.picture(session, ctx, '验证码不正确或已失效，请输入新图片中的数字。');
        return { type: 'challenge', sourceId: session.source.manifest.id, challenge };
      }
    });
  }
}
