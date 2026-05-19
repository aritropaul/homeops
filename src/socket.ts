/**
 * SmartRent Phoenix Channels WebSocket client.
 *
 * Subscribes to per-device channels for real-time attribute updates so we
 * don't have to poll. REST polling remains as a slower fallback for fields
 * that don't come over the socket (battery_level, online).
 *
 * Wire protocol: Phoenix 2.0.0 JSON arrays — [joinRef, msgRef, topic, event, payload].
 */
import WebSocket from 'ws';
import { logger } from './logger.js';
import type { SmartRentClient } from './smartrent.js';

const SOCKET_URL = 'wss://control.smartrent.com/socket/websocket?vsn=2.0.0';
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 300_000;

type PhoenixMessage = [
  joinRef: string | null,
  msgRef: string | null,
  topic: string,
  event: string,
  payload: unknown,
];

export interface AttributeEvent {
  deviceId: string;
  name: string;
  value: string;
}

type Listener = (event: AttributeEvent) => void;

export class SmartRentSocket {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private refCounter = 0;
  private deviceIds: string[];
  private listeners: Listener[] = [];
  private stopped = false;
  private connected = false;

  constructor(
    private client: SmartRentClient,
    deviceIds: string[],
  ) {
    this.deviceIds = [...new Set(deviceIds)];
  }

  /** Subscribe to attribute_state events. Returns an unsubscribe function. */
  onAttribute(handler: Listener): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== handler);
    };
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.connected = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private nextRef(): string {
    return String(++this.refCounter);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const token = await this.client.getAccessToken();
      const url = `${SOCKET_URL}&token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'HomeOps/1.0.0' },
      });
      this.ws = ws;

      ws.on('open', () => {
        logger.info('SmartRent socket connected');
        this.reconnectAttempt = 0;
        this.connected = true;
        for (const deviceId of this.deviceIds) {
          this.join(deviceId);
        }
        this.startHeartbeat();
      });

      ws.on('message', (data) => {
        this.onMessage(data.toString());
      });

      ws.on('error', (err) => {
        logger.warn({ err: err.message }, 'SmartRent socket error');
      });

      ws.on('close', (code, reason) => {
        this.connected = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.stopped) return;
        logger.warn(
          { code, reason: reason.toString() },
          'SmartRent socket closed, scheduling reconnect',
        );
        this.scheduleReconnect();
      });
    } catch (err) {
      logger.error({ err }, 'Socket connect failed');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // 1.25^N + jitter, capped at 5 minutes — matches python-smartrent.
    const base = 1000 * Math.pow(1.25, Math.min(this.reconnectAttempt, 30));
    const jitter = Math.floor(Math.random() * 500);
    const delay = Math.min(base + jitter, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt++;
    logger.info({ delayMs: Math.floor(delay), attempt: this.reconnectAttempt }, 'Reconnecting');
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private send(msg: PhoenixMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private join(deviceId: string): void {
    const ref = this.nextRef();
    this.send([ref, ref, `devices:${deviceId}`, 'phx_join', {}]);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send([null, this.nextRef(), 'phoenix', 'heartbeat', {}]);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private onMessage(data: string): void {
    let msg: PhoenixMessage;
    try {
      msg = JSON.parse(data) as PhoenixMessage;
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg.length < 5) return;

    const [, , topic, event, payload] = msg;

    if (event === 'phx_reply') {
      const reply = payload as { status?: string; response?: unknown };
      if (reply.status === 'error') {
        logger.warn({ topic, response: reply.response }, 'Channel join error');
      }
      return;
    }

    if (event === 'phx_error' || event === 'phx_close') {
      logger.warn({ topic, event }, 'Channel error, will reconnect');
      this.ws?.close();
      return;
    }

    if (event === 'attribute_state') {
      const p = payload as { name?: string; last_read_state?: string; type?: string };
      const match = topic.match(/^devices:(.+)$/);
      if (!match || !p.name || p.last_read_state === undefined) return;
      const deviceId = match[1];
      const evt: AttributeEvent = { deviceId, name: p.name, value: String(p.last_read_state) };
      for (const l of this.listeners) {
        try {
          l(evt);
        } catch (err) {
          logger.error({ err }, 'Attribute listener threw');
        }
      }
    }
  }
}
