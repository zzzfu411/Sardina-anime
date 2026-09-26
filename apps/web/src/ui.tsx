import { createContext, useContext, useState, useRef, useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { kindLabels } from '../../../packages/core/src/discovery';
import { ArrowUpRight, CircleAlert, Film, LoaderCircle, Play, Search, Star } from 'lucide-react';
import type { AnimeCard } from '../../../packages/core/src/types';
import { detailPath, isSessionError } from './api';

interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}
const ToastContext = createContext<(message: string, action?: ToastAction) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const [action, setAction] = useState<ToastAction>();
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider
      value={(message, action) => {
        clearTimeout(timer.current);
        setMessage(message);
        setAction(action);
        timer.current = setTimeout(() => setMessage(''), action ? 30_000 : 4000);
      }}
    >
      {children}
      {message && (
        <div className="toast" role="status">
          {message}
          {action && (
            <button
              className="button secondary small"
              disabled={running}
              onClick={async () => {
                setRunning(true);
                try {
                  await action.run();
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : '操作失败，请重试');
                  setAction(undefined);
                } finally {
                  setRunning(false);
                }
              }}
            >
              {running ? '正在处理…' : action.label}
            </button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}
export function Loading({ label = '正在载入…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={21} />
      {label}
    </div>
  );
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const needsSession = isSessionError(error);
  return (
    <div className="error-state" role="alert">
      <CircleAlert size={24} />
      <div>
        <strong>{needsSession ? '浏览器需要重新连接' : '暂时没有加载成功'}</strong>
        <p>
          {needsSession
            ? '浏览器的访问会话未建立或已失效。请双击项目中的 Start Web.command，或用启动命令重新打开网页，连接本地资料库。'
            : error instanceof Error
              ? error.message
              : '请检查网络后重试'}
        </p>
        {(needsSession || retry) && (
          <button
            className="button secondary small"
            onClick={needsSession ? () => window.location.reload() : retry}
          >
            {needsSession ? '重新检查连接' : '重新加载'}
          </button>
        )}
      </div>
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Film size={40} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Cover({
  card,
  className = '',
  priority = false,
}: {
  card: AnimeCard;
  className?: string;
  priority?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [card.imageUrl]);
  return (
    <div className={`cover ${className}`}>
      {card.imageUrl && !broken ? (
        <img
          src={card.imageUrl}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="cover-placeholder">
          <Film size={28} />
          <span>{card.title.slice(0, 6)}</span>
        </div>
      )}
    </div>
  );
}
export function AnimeTile({
  card,
  sourceName,
  alternatives,
  sourceNames,
  routeState,
  action,
  showDescription = false,
}: {
  card: AnimeCard;
  sourceName?: string;
  alternatives?: AnimeCard[];
  sourceNames?: Record<string, string>;
  routeState?: unknown;
  action?: ReactNode;
  showDescription?: boolean;
}) {
  const location = useLocation();
  const linkState = {
    ...(routeState && typeof routeState === 'object' ? routeState : {}),
    returnTo: location.pathname + location.search,
  };
  return (
    <article className="anime-tile">
      <Link
        to={detailPath(card.sourceId, card.id)}
        state={linkState}
        className="poster-link"
        aria-label={`查看 ${card.title}`}
      >
        <Cover card={card} />
        <span className="poster-play">
          <Play size={22} fill="currentColor" />
        </span>
        {card.remarks && <span className="poster-caption">{card.remarks}</span>}
      </Link>
      <div className="tile-copy">
        <Link to={detailPath(card.sourceId, card.id)} state={linkState} className="tile-title">
          {card.title}
        </Link>
        <div className="tile-meta">
          <span>
            {[card.year, card.kind !== 'unknown' ? kindLabels[card.kind] : undefined, sourceName]
              .filter(Boolean)
              .join(' · ') || '番剧'}
          </span>
          {card.ratings?.[0] ? (
            <span
              className="tile-rating"
              title={card.ratings[0].label}
              aria-label={`${card.ratings[0].label} ${card.ratings[0].score.toFixed(1)} 分`}
            >
              <Star size={12} />
              {card.ratings[0].score.toFixed(1)}
            </span>
          ) : alternatives && alternatives.length > 1 ? (
            <span>{alternatives.length} 个来源</span>
          ) : (
            <ArrowUpRight size={13} />
          )}
        </div>
        {showDescription && (
          <p className="result-description">
            {card.description || card.remarks || '这个来源暂未提供简介，进入详情查看剧集。'}
          </p>
        )}
      </div>
      {alternatives && alternatives.length > 1 && (
        <div className="tile-alternatives">
          {alternatives.map((a) => (
            <Link key={a.sourceId + ':' + a.id} to={detailPath(a.sourceId, a.id)} state={linkState}>
              {sourceNames?.[a.sourceId] ?? a.sourceId}
            </Link>
          ))}
        </div>
      )}
      {action}
    </article>
  );
}
export function SearchEmpty() {
  return (
    <Empty
      title="从一部想看的番剧开始"
      action={
        <span className="hint">
          <Search size={14} />
          在上方输入片名，搜索所有已启用来源
        </span>
      }
    >
      同一部番剧，可以有不止一种观看选择。
    </Empty>
  );
}
