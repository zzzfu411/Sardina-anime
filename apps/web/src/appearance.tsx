import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { AppSettings } from '../../../packages/core/src/types';
import { api, ApiError, preferSettings, putSettings } from './api';
import { useToast } from './ui';

type Appearance = NonNullable<AppSettings['appearance']>;
type Theme = 'dark' | 'light';
const AppearanceContext = createContext<{
  preference: Appearance;
  theme: Theme;
  busy: boolean;
  ready: boolean;
  choose: (value: Appearance) => void;
}>({ preference: 'light', theme: 'light', busy: false, ready: false, choose: () => {} });
export const useAppearance = () => useContext(AppearanceContext);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<AppSettings>('/settings') });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const preference = settings.data?.appearance ?? 'light';
  const theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#05080f' : '#d8d3cc');
  }, [theme]);
  const choose = (appearance: Appearance) => {
    const previous = client.getQueryData<AppSettings>(['settings']);
    if (!previous || saving.current) return;
    saving.current = true;
    setBusy(true);
    client.setQueryData(['settings'], { ...previous, appearance });
    void putSettings(previous, { appearance })
      .then((saved) => {
        client.setQueryData<AppSettings>(['settings'], (latest) => preferSettings(latest, saved));
      })
      .catch((error) => {
        const latest = client.getQueryData<AppSettings>(['settings']);
        if (latest?.generation === previous.generation && latest?.appearance === appearance)
          client.setQueryData(['settings'], { ...latest, appearance: previous.appearance });
        if (error instanceof ApiError && error.code === 'SETTINGS_CHANGED')
          void client.invalidateQueries({ queryKey: ['settings'] });
        toast(error instanceof Error ? error.message : '外观未能保存，请重试');
      })
      .finally(() => {
        saving.current = false;
        setBusy(false);
      });
  };
  return (
    <AppearanceContext.Provider value={{ preference, theme, busy, ready: Boolean(settings.data), choose }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function AppearanceButton() {
  const { theme, choose, busy, ready } = useAppearance();
  const label = theme === 'dark' ? '切换为浅色外观' : '切换为深色外观';
  return (
    <button
      className="icon-button appearance-button"
      aria-label={label}
      title={label}
      disabled={busy || !ready}
      onClick={() => choose(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}

export function AppearanceChoices() {
  const { preference, choose, busy, ready } = useAppearance();
  return (
    <div className="appearance-options" role="group" aria-label="界面外观">
      {(
        [
          { value: 'light', label: '浅色', description: '灰纸与墨色', icon: Sun },
          { value: 'dark', label: '深色', description: '深邃星空黑', icon: Moon },
          { value: 'system', label: '跟随系统', description: '随系统切换', icon: Monitor },
        ] as const
      ).map(({ value, label, description, icon: Icon }) => (
        <button
          key={value}
          className={`appearance-option ${preference === value ? 'selected' : ''}`}
          aria-pressed={preference === value}
          disabled={busy || !ready}
          onClick={() => choose(value)}
        >
          <span className={`appearance-preview preview-${value}`} aria-hidden="true">
            <i />
            <span>
              <b />
              <b />
              <b />
            </span>
          </span>
          <span className="appearance-label">
            <Icon size={16} />
            {label}
            <i aria-hidden="true" />
          </span>
          <small className="appearance-caption" aria-hidden="true">
            {description}
          </small>
        </button>
      ))}
    </div>
  );
}
