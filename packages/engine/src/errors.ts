import type { SearchChallenge } from '../../core/src/types';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export class SearchChallengeError extends AppError {
  constructor(public challenge: SearchChallenge) {
    super('CAPTCHA_REQUIRED', challenge.message, 409);
  }
}
/** Enforce the caller's deadline even if a provider forgets to forward its signal. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof Error && /abort|timeout/i.test(error.name + error.message))
    return { code: 'TIMEOUT', message: '请求超时，请稍后重试或更换来源' };
  if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413)
    return { code: 'PAYLOAD_TOO_LARGE', message: '备份文件超过大小限制' };
  return { code: 'UPSTREAM_ERROR', message: '来源暂时无法连接，请稍后重试' };
}
