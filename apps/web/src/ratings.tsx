import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Search, Star } from 'lucide-react';
import type { AnimeCard, BangumiResult, BangumiSubject } from '../../../packages/core/src/types';
import { api } from './api';

const subjectUrl = (id: string) => `https://bgm.tv/subject/${id}`;
const count = (value: number) => value.toLocaleString('zh-CN');

export function DetailRatings({ card }: { card: AnimeCard }) {
  const client = useQueryClient();
  const key = ['ratings', card.sourceId, card.id];
  const base = `/sources/${encodeURIComponent(card.sourceId)}`;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<BangumiResult>(base + '/ratings?itemId=' + encodeURIComponent(card.id), { signal }),
    staleTime: 6 * 60 * 60_000,
    retry: false,
  });
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState(card.title);
  const [found, setFound] = useState<BangumiSubject[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const subject = query.data?.subject;
  const candidates = found ?? query.data?.candidates ?? [];
  const choose = async (id: string) => {
    setWorking(true);
    setError('');
    try {
      const result = await api<BangumiResult>(base + '/bangumi', {
        method: 'PUT',
        body: JSON.stringify({ itemId: card.id, subjectId: id }),
      });
      // Cancel an earlier automatic lookup so it cannot overwrite this deliberate choice.
      await client.cancelQueries({ queryKey: key });
      client.setQueryData(key, result);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '关联失败，请重试。');
    } finally {
      setWorking(false);
    }
  };
  const search = async () => {
    const value = keyword.trim();
    const id =
      value.match(/^[1-9]\d{0,8}$/)?.[0] ??
      value.match(/^https:\/\/(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/([1-9]\d{0,8})\/?(?:[?#].*)?$/)?.[1];
    // An ID first shows a preview; a separate choice confirms the association.
    if (id) {
      setWorking(true);
      setError('');
      try {
        setFound([await api<BangumiSubject>('/bangumi/subjects/' + id)]);
      } catch (e) {
        setError(e instanceof Error ? e.message : '条目读取失败。');
      } finally {
        setWorking(false);
      }
      return;
    }
    setWorking(true);
    setError('');
    try {
      const result = await api<{ items: BangumiSubject[] }>('/bangumi/search?q=' + encodeURIComponent(value));
      setFound(result.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '搜索失败，请重试。');
    } finally {
      setWorking(false);
    }
  };
  const reset = async () => {
    setWorking(true);
    setError('');
    try {
      await api(base + '/bangumi?itemId=' + encodeURIComponent(card.id), { method: 'DELETE' });
      await client.cancelQueries({ queryKey: key });
      await client.resetQueries({ queryKey: key });
      setFound(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消关联失败。');
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="detail-ratings" aria-label="番剧评分">
      <div className="rating-strip">
        <div className="rating-item bangumi-rating">
          <span className="rating-label">Bangumi</span>
          {subject ? (
            <>
              <a
                href={subjectUrl(subject.id)}
                target="_blank"
                rel="noreferrer"
                className="rating-value"
                aria-label={`查看 Bangumi 条目 ${subject.title}`}
              >
                <strong>{subject.score?.toFixed(1) ?? '暂无评分'}</strong>
                {subject.score !== undefined && <span>/ 10</span>}
                <ExternalLink size={13} />
              </a>
              <span className="rating-note">
                {count(subject.total)} 人评分{subject.rank ? ` · 排名 #${count(subject.rank)}` : ''}
              </span>
            </>
          ) : (
            <>
              <span className="rating-status" role="status">
                {query.isPending
                  ? '正在读取…'
                  : query.isError
                    ? '暂时无法读取'
                    : query.data?.status === 'ambiguous'
                      ? '待确认条目'
                      : '暂无匹配条目'}
              </span>
              {query.isError ? (
                <button className="text-link" onClick={() => void query.refetch()}>
                  重试评分
                </button>
              ) : (
                !query.isPending && (
                  <button className="text-link" onClick={() => setOpen(true)}>
                    选择对应番剧
                  </button>
                )
              )}
            </>
          )}
        </div>
        {card.ratings?.map((rating) => (
          <div className="rating-item" key={rating.label}>
            <span className="rating-label">{rating.label}</span>
            <span className="rating-value">
              <Star size={16} />
              <strong>{rating.score.toFixed(1)}</strong>
              <span>/ 10</span>
            </span>
            <span className="rating-note">
              {rating.total ? `${count(rating.total)} 人评分` : '由来源页面提供'}
            </span>
          </div>
        ))}
      </div>
      {subject && (
        <p className="rating-attribution">
          对应《{subject.title}》{subject.year ? `（${subject.year}）` : ''} ·{' '}
          {query.data?.match === 'manual' ? '手动关联' : '自动匹配'} ·{' '}
          {new Date(subject.fetchedAt).toLocaleDateString('zh-CN')} 获取
        </p>
      )}
      <details className="rating-match" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{subject ? '更改 Bangumi 条目' : '关联 Bangumi 条目'}</summary>
        <div className="rating-match-body">
          <p className="muted">核对片名、年份与季度后选择。合并了多个篇章的番剧，请选择你正在观看的篇章。</p>
          <form
            className="rating-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input
              aria-label="Bangumi 片名或条目链接"
              value={keyword}
              maxLength={200}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="片名、条目编号或 Bangumi 链接"
              required
            />
            <button className="button secondary small" disabled={working || !keyword.trim()}>
              <Search size={15} />
              {working ? '读取中…' : '查找条目'}
            </button>
          </form>
          {error && (
            <p role="alert" className="rating-error">
              {error}
            </p>
          )}
          <div className="rating-candidates" aria-label="Bangumi 候选条目">
            {candidates.map((candidate) => (
              <div className="rating-candidate" key={candidate.id}>
                <div>
                  <a href={subjectUrl(candidate.id)} target="_blank" rel="noreferrer">
                    {candidate.title} <ExternalLink size={12} />
                  </a>
                  <small>
                    {candidate.date ?? '播出日期未知'} · {candidate.platform || '形式未知'} ·{' '}
                    {candidate.score === undefined ? '暂无评分' : `${candidate.score.toFixed(1)} 分`} · #
                    {candidate.id}
                  </small>
                </div>
                <button
                  className="button secondary small"
                  disabled={working}
                  onClick={() => void choose(candidate.id)}
                >
                  选这部
                </button>
              </div>
            ))}
            {!candidates.length && !working && (
              <p className="muted">可以更换片名搜索，或粘贴准确的 Bangumi 条目链接。</p>
            )}
          </div>
          {query.data?.match === 'manual' && (
            <button className="text-link" disabled={working} onClick={() => void reset()}>
              取消手动关联
            </button>
          )}
        </div>
      </details>
    </section>
  );
}
