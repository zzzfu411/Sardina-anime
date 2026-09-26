import { Navigate, Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { LibraryEntry, SourceDetail } from '../../../packages/core/src/types';
import { continuation } from '../../../packages/core/src/progress';
import { api, detailPath, watchPath } from './api';
import { useAnimeHistory } from './history';
import { Loading, ErrorState } from './ui';
import { SourceRecovery } from './source-recovery';

/** Resolve on demand, so a home card never pre-fetches every provider's detail. */
export function ContinuePage() {
  const { sourceId = '', id = '' } = useParams();
  const library = useQuery({ queryKey: ['library'], queryFn: () => api<LibraryEntry[]>('/library') });
  const history = useAnimeHistory({ sourceId, id }, library.data ?? []);
  const detail = useQuery({
    queryKey: ['detail', sourceId, id],
    queryFn: ({ signal }) =>
      api<SourceDetail>(`/sources/${sourceId}/detail?itemId=${encodeURIComponent(id)}`, { signal }),
  });
  if (library.isPending || history.isPending || detail.isPending)
    return <Loading label="正在读取续播位置…" />;
  if (detail.isError)
    return (
      <SourceRecovery sourceId={sourceId} id={id} error={detail.error} retry={() => void detail.refetch()} />
    );
  if (history.isError || library.isError)
    return (
      <>
        <ErrorState
          error={history.error ?? library.error}
          retry={() => {
            void history.refetch();
            void library.refetch();
          }}
        />
        <Link className="button secondary" to={detailPath(sourceId, id)}>
          前往详情选择剧集
        </Link>
      </>
    );
  const target = continuation(detail.data!, history.data ?? []);
  return (
    <Navigate
      replace
      to={
        target.episode && target.line
          ? watchPath(sourceId, id, target.line.id, target.episode.id, target.position)
          : detailPath(sourceId, id)
      }
    />
  );
}
