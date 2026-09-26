import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  refKey,
  type LibraryEntry,
  type SourceState,
  type HistoryEntry,
} from '../../../packages/core/src/types';
import { api, detailPath } from './api';
import { Cover, ErrorState } from './ui';
import './player-recovery.css';

export function SourceRecovery({
  sourceId,
  id,
  error,
  retry,
}: {
  sourceId: string;
  id: string;
  error: unknown;
  retry: () => void;
}) {
  const library = useQuery({ queryKey: ['library'], queryFn: () => api<LibraryEntry[]>('/library') });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api<SourceState[]>('/sources') });
  const history = useQuery({
    queryKey: ['history-recent'],
    queryFn: () => api<HistoryEntry[]>('/history/recent'),
  });
  const entry = library.data?.find((item) =>
    item.refs.some((ref) => ref.sourceId === sourceId && ref.id === id),
  );
  const saved = history.data?.find((item) => item.card.sourceId === sourceId && item.card.id === id);
  const card = entry?.card ?? saved?.card;
  const alternative = sources.data?.find(
    (source) => source.id !== sourceId && source.enabled && source.capabilities.includes('search'),
  );
  return (
    <section className="source-recovery">
      <Link className="back-link" to="/library">
        返回我的番剧
      </Link>
      {card && (
        <div className="recovery-card">
          <Cover card={card} />
          <div>
            <h1>{card.title}</h1>
            <p>本机追番和观看记录仍然保留。</p>
          </div>
        </div>
      )}
      <ErrorState error={error} retry={retry} />
      <div className="source-tabs" aria-label="来源恢复操作">
        {entry?.refs
          .filter((ref) => ref.sourceId !== sourceId || ref.id !== id)
          .map((ref) => (
            <Link className="button secondary" key={refKey(ref)} to={detailPath(ref.sourceId, ref.id)}>
              打开已关联来源 ·{' '}
              {sources.data?.find((source) => source.id === ref.sourceId)?.name ?? ref.sourceId}
            </Link>
          ))}
        {card && (
          <Link
            className="button secondary"
            to={
              '/search?' +
              new URLSearchParams({ q: card.title, ...(alternative ? { source: alternative.id } : {}) })
            }
          >
            查找其他来源
          </Link>
        )}
        <Link className="button secondary" to="/settings">
          管理来源
        </Link>
      </div>
    </section>
  );
}
