import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe';
  instrumentId?: number;
}

interface ServerMessage {
  type: 'fill' | 'batch' | 'mark' | 'ping' | 'snapshot';
  instrumentId?: number;
  data?: unknown;
  ts?: number;
}

export interface WsSnapshotProvider {
  (instrumentId: number): Promise<{ bids: unknown[]; asks: unknown[]; lastTrades: unknown[] }>;
}

export function createWsServer(
  httpServer: Server,
  snapshotProvider?: WsSnapshotProvider,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set<WebSocket>();

  const heartbeat = setInterval(() => {
    const msg: ServerMessage = { type: 'ping', ts: Date.now() };
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }, 30_000);

  wss.on('connection', (ws) => {
    clients.add(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        if (msg.type === 'subscribe' && msg.instrumentId != null) {
          if (snapshotProvider) {
            void snapshotProvider(msg.instrumentId).then((data) => {
              const reply: ServerMessage = {
                type: 'snapshot',
                instrumentId: msg.instrumentId,
                data,
              };
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
            }).catch(() => {
              const reply: ServerMessage = {
                type: 'snapshot',
                instrumentId: msg.instrumentId,
                data: { bids: [], asks: [], lastTrades: [] },
              };
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
            });
          } else {
            const reply: ServerMessage = {
              type: 'snapshot',
              instrumentId: msg.instrumentId,
              data: { bids: [], asks: [], lastTrades: [] },
            };
            ws.send(JSON.stringify(reply));
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
}

export function broadcastFill(
  wss: WebSocketServer,
  instrumentId: number,
  fill: unknown,
): void {
  const msg: ServerMessage = { type: 'fill', instrumentId, data: fill };
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export function broadcastBatch(wss: WebSocketServer, data: unknown): void {
  const msg: ServerMessage = { type: 'batch', data };
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export function broadcastMark(
  wss: WebSocketServer,
  instrumentId: number,
  markPrice: number,
  fundingRate: number,
): void {
  const msg: ServerMessage = {
    type: 'mark',
    instrumentId,
    data: { markPrice, fundingRate },
  };
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}
