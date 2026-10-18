import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { ThemeProvider, useThemeMode } from './theme/ThemeContext';

function ThemedConfig({ children }: { children: React.ReactNode }) {
  const { theme: mode } = useThemeMode();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 6 },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <ThemedConfig>
          <AntApp>
            <App />
          </AntApp>
        </ThemedConfig>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
