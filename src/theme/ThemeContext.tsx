import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'app-theme';

function readInitial(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'; // 默认白色
  } catch {
    return 'light';
  }
}

interface ThemeContextValue {
  theme: ThemeMode;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'light', toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(readInitial);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* 忽略 */ }
    document.body.dataset.theme = theme;
    document.body.style.background = theme === 'dark' ? '#141414' : '#f5f5f5';
  }, [theme]);

  const toggle = useCallback(() => setTheme(t => (t === 'light' ? 'dark' : 'light')), []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useThemeMode() {
  return useContext(ThemeContext);
}
