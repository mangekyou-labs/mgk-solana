'use client';

import { useEffect, useRef, useState } from 'react';
import type { SeriesMarker, Time } from 'lightweight-charts';
import { config } from '@/lib/config';

export interface TradeMarker {
  time: Time;
  price: number;
  side: 'buy' | 'sell';
  qty: number;
  slot: number;
}

interface IndexerMessage {
  type: 'fill' | 'batch' | 'mark' | 'ping' | 'snapshot';
  instrumentId?: number;
  data?: Record<string, unknown>;
  ts?: number;
}

interface FillData {
  slot: number;
  price: number;
  qty: number;
  taker_side: number;
  instrument_id: number;
}

const MAX_MARKERS = 500;

/**
 * Simplified marker for DOM/CSS overlays (no chart-library dependency).
 */
export interface SimpleMarker {
  price: number;
  side: 'buy' | 'sell';
  slot: number;
  qty: number;
}
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

function wsUrl(): string {
  return config.indexerUrl.replace(/^http(s?)/, 'ws$1').replace(/\/$/, '') + '/ws';
}

/**
 * Hook: connects to the indexer WebSocket, subscribes to fills for the
 * given instrument, and returns trade markers for Lightweight Charts
 * plus the latest fill price for the live price line.
 */
export function useIndexerWs(instrumentId: number) {
  const [markers, setMarkers] = useState<SeriesMarker<Time>[]>([]);
  const [simpleMarkers, setSimpleMarkers] = useState<SimpleMarker[]>([]);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const retryIdx = useRef(0);
  const markersRef = useRef<SeriesMarker<Time>[]>([]);
  const simpleRef = useRef<SimpleMarker[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let destroyed = false;

    function scheduleReconnect() {
      if (destroyed) return;
      const delay = RECONNECT_DELAYS[retryIdx.current] ?? 30000;
      if (retryIdx.current < RECONNECT_DELAYS.length - 1) {
        retryIdx.current++;
      }
      timerRef.current = setTimeout(tryConnect, delay);
    }

    function tryConnect() {
      if (destroyed) return;

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        scheduleReconnect();
        return;
      }

      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        retryIdx.current = 0;
        ws.send(JSON.stringify({ type: 'subscribe', instrumentId }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as IndexerMessage;
          if (msg.type === 'ping') return;

          if (msg.type === 'fill' && msg.data) {
            const fill = msg.data as unknown as FillData;
            if (fill.instrument_id !== instrumentId) return;

            const side = fill.taker_side === 0 ? 'buy' : 'sell';
            const price = fill.price / 1_000_000;
            const time = (fill.slot * 0.4) as Time;

            setLastPrice(price);

            const marker: SeriesMarker<Time> = {
              time,
              position: side === 'buy' ? 'belowBar' : 'aboveBar',
              color: side === 'buy' ? '#22c55e' : '#dc2626',
              shape: side === 'buy' ? 'arrowUp' : 'arrowDown',
              text: '●',
            };

            const next = [...markersRef.current, marker].slice(-MAX_MARKERS);
            markersRef.current = next;
            setMarkers(next);

            const simple: SimpleMarker = {
              price,
              side,
              slot: fill.slot,
              qty: fill.qty,
            };
            const nextSimple = [...simpleRef.current, simple].slice(-MAX_MARKERS);
            simpleRef.current = nextSimple;
            setSimpleMarkers(nextSimple);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    tryConnect();

    return () => {
      destroyed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
        wsRef.current = null;
      }
    };
  }, [instrumentId]);

  return { markers, simpleMarkers, lastPrice, isConnected };
}
