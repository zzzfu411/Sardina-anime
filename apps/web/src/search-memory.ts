import { useLayoutEffect, useRef, useState } from 'react';
import { SearchMemory, type SearchMemoryResult } from './search-memory-store';

let cache: SearchMemory | undefined;
function memory() {
  if (!cache) {
    let storage: Storage | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Private browsing may deny tab storage. */
    }
    cache = new SearchMemory(storage);
  }
  return cache;
}

/** Call from a component keyed by source+keyword. Completed pages survive route unmounts. */
export function useSearchMemory<T extends SearchMemoryResult>(
  sourceId: string,
  keyword: string,
  location: string,
) {
  const initial = useRef(memory().get(sourceId, keyword));
  const [results, setResults] = useState<Record<string, T>>(
    () => (initial.current?.results ?? {}) as Record<string, T>,
  );
  const latest = useRef(results);
  latest.current = results;
  const restored = useRef(Boolean(initial.current && Object.keys(initial.current.results).length)).current;
  const scroll = useRef(initial.current?.positions[location] ?? 0);
  const suppressScroll = useRef(false);

  useLayoutEffect(() => {
    const saved = memory().get(sourceId, keyword)?.positions[location];
    const target = Number.isFinite(saved) ? saved! : 0;
    // Keep the intended position during StrictMode's setup/cleanup replay and before layout settles.
    scroll.current = target;
    suppressScroll.current = true;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        window.scrollTo({ top: target, behavior: 'instant' });
        scroll.current = window.scrollY;
        suppressScroll.current = false;
      });
    });
    const moved = () => {
      if (!suppressScroll.current) scroll.current = window.scrollY;
    };
    window.addEventListener('scroll', moved, { passive: true });
    const save = () => memory().set(sourceId, keyword, latest.current, location, scroll.current);
    window.addEventListener('pagehide', save);
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      window.removeEventListener('scroll', moved);
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [sourceId, keyword, location]);

  useLayoutEffect(() => {
    memory().set(sourceId, keyword, results, location, scroll.current);
  }, [sourceId, keyword, location, results]);

  return {
    results,
    setResults,
    restored,
    clearMemory: () => {
      memory().clear(sourceId, keyword);
      scroll.current = 0;
    },
  };
}
