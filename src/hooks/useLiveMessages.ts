import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import type { Message as Msg, PermissionRequest } from '../types';

/**
 * 会话实时消息流：封装 ai_message / thinking_delta / tool_use /
 * permission_request 的 WS 处理与消息累积。流水线会话详情与 Claude 对话页共用。
 * 空内容的 ai_message（done 信号）不产生气泡，UI 刷新由 status_change 驱动。
 */
export function useLiveMessages(sessionId: string | undefined) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const thinkingDoneRef = useRef<Set<string>>(new Set());
  const { connected, on, send } = useWebSocket(sessionId);

  // 会话切换：清空状态
  useEffect(() => {
    thinkingDoneRef.current = new Set();
    setMessages([]);
    setPermissionRequest(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const unsubs = [
      on('ai_message', (data) => {
        if (!data.content) return; // 空内容仅是结束信号
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && !data.done) {
            return [...prev.slice(0, -1), { ...last, content: last.content + data.content }];
          }
          return [...prev, {
            id: `ai-${Date.now()}`, sessionId: sessionId!, stepId: data.stepId,
            role: 'assistant', content: data.content, createdAt: new Date().toISOString(),
          }];
        });
      }),
      on('thinking_delta', (data) => {
        const { content, done } = data;
        if (!content && done) return;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && !thinkingDoneRef.current.has(last.id)) {
            const updatedThinking = (last.thinking || '') + content;
            if (done) thinkingDoneRef.current.add(last.id);
            return [...prev.slice(0, -1), { ...last, thinking: updatedThinking }];
          }
          const newMsg: Msg = {
            id: `ai-${Date.now()}`, sessionId: sessionId!, role: 'assistant',
            content: '', thinking: content, createdAt: new Date().toISOString(),
          };
          if (done) thinkingDoneRef.current.add(newMsg.id);
          return [...prev, newMsg];
        });
      }),
      on('tool_use', (data) => {
        setMessages(prev => [...prev, {
          id: `tool-${Date.now()}`, sessionId: sessionId!, role: 'system',
          content: `⚡ Tool: ${data.toolName} - ${JSON.stringify(data.input).substring(0, 100)}`,
          createdAt: new Date().toISOString(),
        }]);
      }),
      on('permission_request', (data) => {
        setPermissionRequest(data);
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [on, sessionId]);

  return { messages, setMessages, permissionRequest, setPermissionRequest, thinkingDoneRef, connected, on, send };
}
