import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { SearchChallenge, SearchContinuation } from '../../../packages/core/src/types';
import { api, ApiError } from './api';

/** Each new image has a new key, so a previous picture's input can never be submitted for it. */
export function SearchCaptcha({
  challenge,
  name,
  focus,
  hasSourceResults,
  onContinue,
  onCancel,
  onRestart,
}: {
  challenge: SearchChallenge;
  name: string;
  focus?: boolean;
  hasSourceResults?: boolean;
  onContinue: (result: SearchContinuation) => void;
  onCancel: () => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(Date.parse(challenge.expiresAt) <= Date.now());
  const [imageFailed, setImageFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController>(undefined);
  const inputId = `captcha-${challenge.id}`;
  useEffect(() => {
    if (focus) input.current?.focus();
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(challenge.expiresAt) - Date.now()),
    );
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [challenge.id, challenge.expiresAt, focus]);

  const act = async (refresh: boolean) => {
    if (busy || expired) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api<SearchContinuation>(
        `/search/challenges/${challenge.id}${refresh ? '/refresh' : ''}`,
        {
          method: 'POST',
          signal: controller.signal,
          ...(!refresh ? { body: JSON.stringify({ code }) } : {}),
        },
      );
      if (!controller.signal.aborted) onContinue(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : '暂时无法连接，请重试。');
      // A refresh replaces the upstream code immediately, even if its response is lost.
      if (
        refresh ||
        (error instanceof ApiError && ['CAPTCHA_EXPIRED', 'INVALID_CAPTCHA'].includes(error.code))
      )
        setExpired(true);
      else input.current?.focus();
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <section className="search-captcha" aria-labelledby={`${inputId}-title`}>
      <div className="captcha-heading">
        <span className="eyebrow">搜索验证</span>
        <h2 id={`${inputId}-title`}>{name} · 请输入验证码</h2>
        <p id={`${inputId}-help`} aria-live="polite">
          {expired ? '这张验证码已失效，请重新获取。' : challenge.message}
        </p>
        <p className="captcha-note">
          {hasSourceResults
            ? '已返回的结果可继续浏览，验证后加载这个来源的更多结果。'
            : `输入验证码后继续搜索 ${name}，也可以在上方切换其他来源。`}
        </p>
      </div>
      <form
        className="captcha-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (/^\d{4}$/.test(code)) void act(false);
        }}
      >
        <div className="captcha-picture">
          {expired ? (
            <span className="captcha-placeholder">图片已失效</span>
          ) : imageFailed ? (
            <span className="captcha-placeholder" role="alert">
              图片未加载
            </span>
          ) : (
            <img src={challenge.imageUrl} alt={`${name} 搜索验证码`} onError={() => setImageFailed(true)} />
          )}
          {!expired && (
            <button type="button" className="text-link" disabled={busy} onClick={() => void act(true)}>
              <RefreshCw size={13} /> 换一张
            </button>
          )}
        </div>
        <div className="captcha-entry">
          {!expired && (
            <>
              <label htmlFor={inputId}>图片中的 4 位数字</label>
              <input
                id={inputId}
                ref={input}
                type="text"
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                autoComplete="off"
                spellCheck={false}
                required
                value={code}
                disabled={busy || imageFailed}
                aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ''}`}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
              />
            </>
          )}
          <div className="captcha-actions">
            {expired ? (
              <button type="button" className="button primary small" onClick={onRestart}>
                重新获取验证码
              </button>
            ) : (
              <button
                className="button primary small"
                type="submit"
                disabled={busy || imageFailed || code.length !== 4}
              >
                {busy ? '正在验证…' : '验证并搜索'}
                {!busy && <ArrowRight size={15} />}
              </button>
            )}
            <button
              type="button"
              className="text-link"
              onClick={() => {
                request.current?.abort();
                void api(`/search/challenges/${challenge.id}`, { method: 'DELETE' }).catch(() => {});
                onCancel();
              }}
            >
              取消验证
            </button>
          </div>
          {error && (
            <p className="captcha-error" id={`${inputId}-error`} role="alert">
              {error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
