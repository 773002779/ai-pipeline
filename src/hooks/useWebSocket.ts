import { useEffect, useRef, useCallback, useState } from 'react';
import type { WsServerEvent, WsClientEvent } from '../types';

export function useWebSocket(sessionId: string | undefined) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef<Map<string, Set<(data: any) => void>>>(new Map());
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  useEffect(() => {
    if (!sessionId) return;

    // Fresh session → fresh reconnect budget
    reconnectAttempts.current = 0;

    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (unmounted) return;
      if (reconnectAttempts.current >= maxReconnectAttempts) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/session?sessionId=${sessionId}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectAttempts.current = 0; // Reset on successful connection
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        // Reconnect with backoff (only for unexpected disconnects)
        if (!unmounted && reconnectAttempts.current < maxReconnectAttempts) {
          reconnectAttempts.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 15000);
          reconnectTimer = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this — reconnect handled there
      };

      ws.onmessage = (event) => {
        try {
          const msg: WsServerEvent = JSON.parse(event.data);
          const handlers = handlersRef.current.get(msg.type);
          if (handlers) {
            handlers.forEach(handler => handler((msg as any).data));
          }
        } catch { /* ignore parse errors */ }
      };
    };

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [sessionId]);

  const on = useCallback((eventType: string, handler: (data: any) => void) => {
    if (!handlersRef.current.has(eventType)) {
      handlersRef.current.set(eventType, new Set());
    }
    handlersRef.current.get(eventType)!.add(handler);

    return () => {
      handlersRef.current.get(eventType)?.delete(handler);
    };
  }, []);

  const send = useCallback((event: WsClientEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  return { connected, on, send };
}
