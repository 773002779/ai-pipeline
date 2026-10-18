// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatMessages from '../ChatMessages';
import type { Message as Msg } from '../../types';

const msgs: Msg[] = [
  { id: '1', sessionId: 's', role: 'user', content: '你好', createdAt: '2026-01-01T00:00:00Z' },
  { id: '2', sessionId: 's', role: 'assistant', content: '有什么可以帮你？', createdAt: '2026-01-01T00:00:01Z' },
];

describe('ChatMessages', () => {
  beforeEach(() => {
    // jsdom 未实现 scrollIntoView（组件挂载时自动滚动会调用）
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('渲染用户与助手气泡', () => {
    render(<ChatMessages messages={msgs} thinkingPendingIds={new Set()} />);
    expect(screen.getByText('你好')).toBeDefined();
    expect(screen.getByText('有什么可以帮你？')).toBeDefined();
    expect(screen.getByText(/👤 你/)).toBeDefined();
  });

  it('带 thinking 的助手消息渲染思考区', () => {
    const withThinking: Msg[] = [{ ...msgs[1], thinking: '思考内容' }];
    render(<ChatMessages messages={withThinking} thinkingPendingIds={new Set(['2'])} />);
    expect(screen.getByText(/思考过程/)).toBeDefined();
  });

  it('空消息显示占位', () => {
    render(<ChatMessages messages={[]} thinkingPendingIds={new Set()} />);
    expect(screen.getByText('暂无消息')).toBeDefined();
  });
});
