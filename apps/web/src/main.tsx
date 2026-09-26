import React, { useEffect, useRef, useState, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  Home,
  Search,
  Bookmark,
  History,
  Settings,
  ChevronRight,
  Grid2X2,
  CalendarDays,
  MoreHorizontal,
  X,
  ArrowRight,
} from 'lucide-react';
import type { LibraryEntry, SourceState } from '../../../packages/core/src/types';
import { api, isSessionError } from './api';
import { Loading, ToastProvider } from './ui';
import { HomePage, SearchPage, DetailPage, LibraryPage, HistoryPage, SettingsPage } from './pages';
import './style.css';
import { CatalogPage, CalendarPage } from './discovery';
import { AppearanceButton, AppearanceProvider } from './appearance';
import { SearchSourceContext } from './search-source';
import { HistoryProvider } from './history';
import { ContinuePage } from './continue';
import { useSourcePreference } from './module-source';
const WatchPage = lazy(() => import('./watch'));
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => !isSessionError(error) && failureCount < 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [searchSourceId, setSearchSourceId, searchSourceReady] = useSourcePreference('search');
  const searchInput = useRef<HTMLInputElement>(null);
  const moreDialog = useRef<HTMLDialogElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = isMac ? '⌘' : 'Ctrl';
  useEffect(() => {
    setSearch(new URLSearchParams(location.search).get('q') ?? '');
    moreDialog.current?.close();
  }, [location.pathname, location.search]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.isComposing) return;
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        moreDialog.current?.close();
        searchInput.current?.focus();
        searchInput.current?.select();
      } else if (event.key === ',') {
        event.preventDefault();
        navigate('/settings');
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [navigate]);
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api<SourceState[]>('/sources') });
  const searchSources =
    sources.data?.filter((source) => source.enabled && source.capabilities.includes('search')) ?? [];
  const requestedSource =
    location.pathname === '/search' ? new URLSearchParams(location.search).get('source') : null;
  const searchSource =
    !searchSourceReady && !requestedSource
      ? undefined
      : requestedSource && requestedSource !== 'all'
        ? searchSources.find((source) => source.id === requestedSource)
        : (searchSources.find((source) => source.id === searchSourceId) ?? searchSources[0]);
  useEffect(() => {
    if (searchSource && (searchSourceReady || requestedSource)) setSearchSourceId(searchSource.id);
  }, [searchSource?.id, setSearchSourceId, searchSourceReady, requestedSource]);
  const chooseSearchSource = (id: string) => {
    if (!searchSources.some((source) => source.id === id)) return;
    setSearchSourceId(id);
    if (location.pathname === '/search' && searchSource?.id !== id) {
      const params = new URLSearchParams(location.search);
      params.set('source', id);
      for (const key of ['kind', 'year', 'sort']) params.delete(key);
      navigate('/search?' + params, { state: location.state });
    }
  };
  const library = useQuery({ queryKey: ['library'], queryFn: () => api<LibraryEntry[]>('/library') });
  const watch = location.pathname.startsWith('/watch/');
  return (
    <SearchSourceContext.Provider
      value={{
        sources: searchSources,
        source: searchSource,
        choose: chooseSearchSource,
        pending: sources.isPending || (!searchSourceReady && !requestedSource),
        error: sources.error,
        retry: () => void sources.refetch(),
      }}
    >
      <div className={`app-shell ${watch ? 'watch-shell' : ''}`}>
        <a className="skip-link" href="#main-content">
          跳到内容
        </a>
        <aside className="sidebar">
          <div className="window-drag" />
          <Link to="/" className="brand" aria-label="Sardina anime 首页">
            <img className="brand-mark" src="/brand/sardina-anime-right.png" alt="" width="156" height="64" />
            <span className="brand-wordmark" aria-hidden="true">
              Sardina
              <span className="brand-anime" />
            </span>
          </Link>
          <nav aria-label="主导航">
            <span className="nav-group-label">浏览</span>
            {[
              { to: '/', label: '发现', icon: Home, end: true },
              { to: '/catalog', label: '番剧索引', icon: Grid2X2 },
              { to: '/calendar', label: '每周放送', icon: CalendarDays },
              { to: '/search', label: '搜索', icon: Search },
              { to: '/library', label: '我的番剧', icon: Bookmark },
              { to: '/history', label: '观看记录', icon: History },
            ].map(({ to, label, icon: Icon, end }, index) => (
              <React.Fragment key={to}>
                {index === 4 && <span className="nav-group-label library-nav-label">资料库</span>}
                <NavLink
                  to={to}
                  aria-label={label}
                  end={end}
                  className={({ isActive }) =>
                    `nav-item ${isActive ? 'active' : ''} ${to === '/search' || to === '/history' ? 'desktop-only-nav' : ''}`
                  }
                >
                  <Icon size={19} aria-hidden="true" />
                  <span>{label}</span>
                  {to === '/library' && !!library.data?.length && <small>{library.data.length}</small>}
                </NavLink>
              </React.Fragment>
            ))}
            <button
              ref={moreButton}
              className={`nav-item mobile-more ${moreOpen || ['/search', '/history', '/settings'].includes(location.pathname) ? 'active' : ''}`}
              aria-label="更多功能"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => {
                moreDialog.current?.showModal();
                setMoreOpen(true);
              }}
            >
              <MoreHorizontal size={21} aria-hidden="true" />
              <span>更多</span>
            </button>
          </nav>
          <div className="sidebar-bottom">
            <div className="local-note">
              <span
                className={`status-dot ${sources.isError ? 'error' : sources.isPending ? 'pending' : ''}`}
              />
              <div>
                本机资料库
                <small>
                  {sources.isError
                    ? isSessionError(sources.error)
                      ? '等待重新连接'
                      : '来源列表加载失败'
                    : sources.isPending
                      ? '正在连接…'
                      : `${sources.data.filter((s) => s.enabled).length} 个来源已启用`}
                </small>
              </div>
            </div>
            <NavLink
              to="/settings"
              aria-label="设置"
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            >
              <Settings size={20} />
              <span>设置</span>
              <kbd aria-hidden="true">{shortcut} ,</kbd>
            </NavLink>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <form
              className="search-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (search.trim() && searchSource)
                  navigate('/search?' + new URLSearchParams({ q: search.trim(), source: searchSource.id }));
              }}
              role="search"
            >
              <select
                aria-label="搜索来源"
                className="search-source-select"
                value={searchSource?.id ?? ''}
                disabled={!searchSources.length}
                onChange={(event) => chooseSearchSource(event.target.value)}
              >
                {!searchSource && <option value="">选择来源</option>}
                {searchSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
              <input
                aria-label="搜索番剧"
                ref={searchInput}
                placeholder="输入番剧名称"
                maxLength={150}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search ? (
                <button
                  type="button"
                  className="clear-search"
                  aria-label="清除搜索内容"
                  onClick={() => {
                    setSearch('');
                    searchInput.current?.focus();
                  }}
                >
                  <X size={15} />
                </button>
              ) : (
                <kbd className="search-shortcut">{shortcut} K</kbd>
              )}
              <button type="submit" aria-label="开始搜索" disabled={!searchSource}>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </form>
            <span className="topbar-date">
              {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
            </span>
            <AppearanceButton />
          </header>
          <main id="main-content" tabIndex={-1} className={watch ? 'page watch-page' : 'page'}>
            <Suspense fallback={<Loading />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
        <dialog
          ref={moreDialog}
          className="more-dialog"
          aria-labelledby="more-title"
          onClose={() => {
            setMoreOpen(false);
            if (document.activeElement === document.body) moreButton.current?.focus();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) moreDialog.current?.close();
          }}
        >
          <div className="more-sheet">
            <div className="section-heading">
              <h2 id="more-title">更多功能</h2>
              <button
                className="icon-button"
                aria-label="关闭更多功能"
                onClick={() => moreDialog.current?.close()}
              >
                <X size={21} />
              </button>
            </div>
            <nav aria-label="更多导航">
              {[
                { to: '/search', label: '搜索番剧', icon: Search },
                { to: '/history', label: '观看记录', icon: History },
                { to: '/settings', label: '设置与外观', icon: Settings },
              ].map(({ to, label, icon: Icon }) => (
                <Link key={to} to={to} onClick={() => moreDialog.current?.close()}>
                  <Icon size={21} aria-hidden="true" />
                  <span>{label}</span>
                  <ChevronRight size={16} aria-hidden="true" />
                </Link>
              ))}
            </nav>
          </div>
        </dialog>
      </div>
    </SearchSourceContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppearanceProvider>
          <HistoryProvider>
            <BrowserRouter>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<HomePage />} />
                  <Route path="search" element={<SearchPage />} />
                  <Route path="catalog" element={<CatalogPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="anime/:sourceId/:id" element={<DetailPage />} />
                  <Route path="continue/:sourceId/:id" element={<ContinuePage />} />
                  <Route path="watch/:sourceId/:id" element={<WatchPage />} />
                  <Route path="library" element={<LibraryPage />} />
                  <Route path="history" element={<HistoryPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<HomePage />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </HistoryProvider>
        </AppearanceProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
