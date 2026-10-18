// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThemeProvider, useThemeMode } from '../ThemeContext';

function Probe() {
  const { theme, toggle } = useThemeMode();
  return (
    <div>
      <span data-testid="mode">{theme}</span>
      <button onClick={toggle}>toggle</button>
    </div>
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.body.dataset.theme;
  });

  it('默认 light 主题（白色）', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('light');
  });

  it('切换后持久化 localStorage 并更新 body 标记', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => { screen.getByText('toggle').click(); });
    expect(screen.getByTestId('mode').textContent).toBe('dark');
    expect(localStorage.getItem('app-theme')).toBe('dark');
    expect(document.body.dataset.theme).toBe('dark');
  });

  it('localStorage 为 dark 时初始为 dark', () => {
    localStorage.setItem('app-theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('dark');
  });

  it('非法存储值回退 light', () => {
    localStorage.setItem('app-theme', 'blue');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('light');
  });
});
