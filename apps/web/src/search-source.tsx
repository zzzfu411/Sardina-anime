import { createContext, useContext } from 'react';
import { Link } from 'react-router-dom';
import type { SourceState } from '../../../packages/core/src/types';

export interface SearchSourceSelection {
  sources: SourceState[];
  source?: SourceState;
  choose: (id: string) => void;
  pending: boolean;
  error: Error | null;
  retry: () => void;
}
export const SearchSourceContext = createContext<SearchSourceSelection | null>(null);
export function useSearchSource() {
  const selection = useContext(SearchSourceContext);
  if (!selection) throw new Error('Search source selection is unavailable');
  return selection;
}

export function SearchSourcePicker({ status }: { status?: string }) {
  const { sources, source, choose } = useSearchSource();
  return (
    <section className="search-source-picker" aria-label="选择搜索来源">
      <div className="search-source-heading">
        <span>当前搜索来源</span>
        <span className="search-source-status" role="status">
          {status ?? '每次只搜索所选来源，下次会记住你的选择'}
        </span>
      </div>
      <div className="source-tabs">
        {sources.map((item) => (
          <button
            key={item.id}
            className={source?.id === item.id ? 'chip selected' : 'chip'}
            aria-pressed={source?.id === item.id}
            onClick={() => choose(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>
      {!sources.length && (
        <p className="muted">
          暂无可搜索的来源，请在 <Link to="/settings">设置</Link> 中启用。
        </p>
      )}
    </section>
  );
}
