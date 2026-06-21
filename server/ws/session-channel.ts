import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsServerEvent, WsClientEvent } from '../../shared/types';

interface ClientInfo {
  ws: WebSocket;
  sessionId: string;
}

export class SessionChannel {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ClientInfo> = new Map();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws/session' });

    this.wss.on('connection', (ws: WebSocket, req) => {
      // Parse sessionId from query string
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const sessionId = url.searchParams.get('sessionId') || 'unknown';

      this.clients.set(ws, { ws, sessionId });
      console.log(`WS client connected for session: ${sessionId}`);

      ws.on('message', (raw) => {
        try {
          const event: WsClientEvent = JSON.parse(raw.toString());
          this.handleClientMessage(ws, event);
        } catch { /* ignore malformed messages */ }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`WS client disconnected from session: ${sessionId}`);
      });
    });
  }

  /** Broadcast event to all clients watching a specific session */
  broadcastToSession(sessionId: string, event: WsServerEvent): void {
    const message = JSON.stringify(event);
    for (const [, client] of this.clients) {
      if (client.sessionId === sessionId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  /** Send event to a specific client */
  sendToClient(ws: WebSocket, event: WsServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  private handleClientMessage(ws: WebSocket, event: WsClientEvent): void {
    // Client events are forwarded to the session handler
    // For now, log them; actual handling is done via REST API
    console.log(`WS client event: ${event.type}`);
  }

  /** Get number of connected clients */
  getClientCount(): number {
    return this.clients.size;
  }
}
