import { useEffect, useRef } from 'react';
import { Typography, theme as antdTheme } from 'antd';
import type { Message as Msg } from '../types';
import ThinkingSection from './ThinkingSection';

interface Props {
  messages: Msg[];
  /** thinking 仍在流式接收的消息 id 集合 */
  thinkingPendingIds: Set<string>;
  height?: number | string;
}

export default function ChatMessages({ messages, thinkingPendingIds, height = 450 }: Props) {
  const { token } = antdTheme.useToken();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={{ height, overflow: 'auto', padding: 16, background: token.colorBgLayout }}>
      {messages.length === 0 && <Typography.Text type="secondary">暂无消息</Typography.Text>}
      {messages.map(m => (
        <div key={m.id} style={{ marginBottom: 10, display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
          <div style={{
            maxWidth: '85%', padding: '8px 12px', borderRadius: 8,
            background: m.role === 'user' ? token.colorPrimary
              : m.role === 'system' ? token.colorFillSecondary : token.colorFillTertiary,
            color: m.role === 'user' ? token.colorTextLightSolid
              : m.role === 'system' ? token.colorWarning : token.colorText,
            border: m.role === 'system' ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}>
            <Typography.Text style={{
              color: m.role === 'user' ? 'rgba(255,255,255,0.8)' : token.colorTextSecondary,
              fontSize: 10, display: 'block',
            }}>
              {m.role === 'user' ? '👤 你' : m.role === 'system' ? '⚡ 系统' : '🤖 AI'}
              {' · '}{new Date(m.createdAt).toLocaleTimeString()}
            </Typography.Text>
            {m.role === 'assistant' && m.thinking && (
              <ThinkingSection thinking={m.thinking} streaming={thinkingPendingIds.has(m.id)} />
            )}
            <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
              {m.content}
            </div>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
