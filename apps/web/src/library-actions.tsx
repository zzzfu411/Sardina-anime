import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnimeCard,
  LibraryEntry,
  LibraryLinkPreview,
  SourceRef,
} from '../../../packages/core/src/types';
import { kindLabels } from '../../../packages/core/src/discovery';
import { statusLabels } from '../../../packages/core/src/types';
import { api, patch, post } from './api';
import { ErrorState, Loading, useToast } from './ui';
import './library-actions.css';

export function useLibraryActions() {
  const client = useQueryClient();
  const toast = useToast();
  const changed = () => client.invalidateQueries({ queryKey: ['library'] });
  return {
    remove: async (entry: LibraryEntry) => {
      const result = await api<{ undoToken: string }>(`/library/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
      });
      await changed();
      toast(`已取消「${entry.card.title}」的追番`, {
        label: '撤销',
        run: async () => {
          await post('/library/undo', { token: result.undoToken });
          await changed();
          toast('已恢复追番状态及来源关联');
        },
      });
    },
    unlink: async (entry: LibraryEntry, ref: SourceRef) => {
      await patch(`/library/${encodeURIComponent(entry.id)}`, { unlinkRef: ref, revision: entry.revision });
      await changed();
      toast('已解除该来源关联，观看记录仍保留');
    },
  };
}

export function AssociationDialog({
  card,
  target,
  libraryId,
  onClose,
  onLinked,
}: {
  card: AnimeCard;
  target: AnimeCard;
  libraryId?: string;
  onClose: () => void;
  onLinked: (entry: LibraryEntry) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const preview = useQuery({
    queryKey: ['library-link-preview', card.sourceId, card.id, target.sourceId, target.id, libraryId],
    queryFn: () => post<LibraryLinkPreview>('/library/link/preview', { card, target, libraryId }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const confirm = async () => {
    if (!preview.data || !confirmed) return;
    setBusy(true);
    setError('');
    try {
      const entry = await post<LibraryEntry>('/library/link', { token: preview.data.token });
      await client.invalidateQueries({ queryKey: ['library'] });
      onLinked(entry);
    } catch (error) {
      setError(error instanceof Error ? error.message : '关联失败，请重试');
      setConfirmed(false);
      void preview.refetch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      className="association-dialog"
      ref={dialog}
      aria-labelledby="association-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={onClose}
    >
      <h2 id="association-title">确认来源关联</h2>
      <div className="association-comparison">
        {[card, target].map((item, index) => (
          <div key={index}>
            <small>
              {index ? '将关联的来源' : '保留的主记录'} · {item.sourceId}
            </small>
            <h3>{item.title}</h3>
            <p>
              {[
                item.year ? `${item.year} 年` : '年份未知',
                item.season === undefined ? '季度未标注' : `第 ${item.season} 季`,
                kindLabels[item.kind],
              ].join(' · ')}
            </p>
          </div>
        ))}
      </div>
      {preview.isPending ? (
        <Loading label="正在核对关联影响…" />
      ) : preview.isError ? (
        <ErrorState error={preview.error} retry={() => void preview.refetch()} />
      ) : (
        preview.data && (
          <>
            <p>
              {preview.data.creates ? '确认后才会新增收藏。' : '保留当前收藏。'}收藏状态：
              {statusLabels[preview.data.status]}；共保留 {preview.data.refs.length} 个来源。
            </p>
            {preview.data.merged.length > 0 && (
              <div className="info-banner">
                以下收藏将合并为一条，保留主记录的状态：
                {preview.data.merged
                  .map((item) => `${item.card.title}（${statusLabels[item.status]}）`)
                  .join('、')}
                。观看记录保留；之后可解除单个备用来源。
              </div>
            )}
            <label className="association-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              我已确认这是同一季度和版本
            </label>
          </>
        )
      )}
      {error && <p role="alert">{error}</p>}
      <div className="association-buttons">
        <button className="button secondary" disabled={busy} onClick={() => dialog.current?.close()}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || !confirmed || !preview.data || preview.isFetching}
          onClick={() => void confirm()}
        >
          {busy ? '正在关联…' : '确认关联'}
        </button>
      </div>
    </dialog>
  );
}
