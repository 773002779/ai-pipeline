import { useEffect, useState } from 'react';
import { theme as antdTheme } from 'antd';

interface Props {
  thinking: string;
  streaming: boolean;
}

export default function ThinkingSection({ thinking, streaming }: Props) {
  const { token } = antdTheme.useToken();
  const [collapsed, setCollapsed] = useState(true);

  // Inject thinking blink animation style (singleton per DOM; removed only by the instance that created it)
  useEffect(() => {
    if (document.getElementById('thinking-blink-style')) return;
    const style = document.createElement('style');
    style.id = 'thinking-blink-style';
    style.textContent = `@keyframes thinking-blink { 50% { opacity: 0; } }
      .thinking-cursor { animation: thinking-blink 1s step-end infinite; }`;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);

  useEffect(() => {
    if (streaming) {
      setCollapsed(false);
    } else {
      const timer = setTimeout(() => setCollapsed(true), 2000);
      return () => clearTimeout(timer);
    }
  }, [streaming]);

  return (
    <div style={{
      marginTop: 6, marginBottom: 8,
      background: token.colorFillSecondary,
      border: `1px solid ${token.colorBorder}`,
      borderRadius: 6, padding: '6px 10px', fontSize: 12, lineHeight: 1.5,
    }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none', color: token.colorTextSecondary }}
      >
        <span>🧠</span>
        <span style={{ fontWeight: 500, fontSize: 11 }}>
          思考过程
          {streaming && <span style={{ marginLeft: 4, color: token.colorTextQuaternary, fontSize: 10 }}>(思考中...)</span>}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: token.colorTextQuaternary }}>
          {collapsed ? '▶ 展开' : '▼ 收起'}
        </span>
      </div>
      {!collapsed && (
        <div style={{
          marginTop: 6, padding: '6px 8px',
          background: token.colorFillTertiary, borderRadius: 4,
          color: token.colorTextSecondary, fontStyle: 'italic',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: streaming ? 300 : 2000,
          overflowY: streaming ? 'auto' : 'visible', fontSize: 11,
        }}>
          {thinking}
          {streaming && <span className="thinking-cursor">|</span>}
        </div>
      )}
    </div>
  );
}
