import { readFileSync } from 'node:fs';
import { AppError } from '../packages/engine/src/errors';
import { fakeSource, card } from './helpers';

/** Controlled sample only: no recognition or requests to a real provider. */
export function captchaSource(id = 'captcha') {
  const cookieUrl = 'https://captcha.example/';
  return fakeSource(id, {
    getHome: async () => [],
    search: async (input, ctx) => {
      if (!(await ctx.http.jar.getCookieString(cookieUrl)).includes('verified=yes'))
        throw new AppError('CAPTCHA_REQUIRED', '请输入验证码', 409);
      return {
        page: input.page,
        hasMore: input.page < 2,
        items: [{ ...card, sourceId: id, id: `page-${input.page}`, title: input.keyword }],
      };
    },
    getSearchCaptcha: async (ctx) => {
      await ctx.http.jar.setCookie('expected=3572; Path=/', cookieUrl);
      return {
        body: readFileSync(new URL('./fixtures/girigiri-3572.png', import.meta.url)),
        contentType: 'image/png',
      };
    },
    submitSearchCaptcha: async (code, ctx) => {
      if (code !== '3572' || !(await ctx.http.jar.getCookieString(cookieUrl)).includes('expected=3572'))
        throw new AppError('CAPTCHA_INCORRECT', '验证码不正确', 409);
      await ctx.http.jar.setCookie('verified=yes; Path=/', cookieUrl);
    },
  });
}
