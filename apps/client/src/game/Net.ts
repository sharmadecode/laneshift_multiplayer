import { io, type Socket } from 'socket.io-client';
import {
  CONNECT_TIMEOUT_MS,
  NET_EVENTS,
  TICK_RATE,
  type ClientInput,
  type CrashMsg,
  type InputMsg,
  type WelcomeMsg,
  type WorldSnapshot
} from '@hr/shared';

export interface NetCallbacks {
  onSnapshot: (snap: WorldSnapshot) => void;
  onCrash: (msg: CrashMsg) => void;
  onWelcome: (w: WelcomeMsg) => void;
}

// One input per server tick keeps the client-side grid prediction aligned
// with the server simulation (the server applies only the latest input per tick).
const SEND_RATE = TICK_RATE;

/**
 * Where the authoritative server lives. Env override wins; otherwise the game
 * server is assumed to run on the same host the page was served from (dev:
 * vite on :5199, game server on :5200 — desktop localhost or phone via LAN IP).
 */
function serverUrl(): string | undefined {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  const host = location.hostname;
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:5200`;
  }
  return 'http://localhost:5200';
}

export class Net {
  playerId = '';
  roomId = '';
  lastSnapshot: WorldSnapshot | null = null;

  private socket: Socket | null = null;
  private seq = 0;
  private lastSend = 0;
  private cb: NetCallbacks;

  constructor(cb: NetCallbacks) {
    this.cb = cb;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = serverUrl();
      const socket = url ? io(url, { transports: ['websocket'], timeout: CONNECT_TIMEOUT_MS }) : io({ transports: ['websocket'], timeout: CONNECT_TIMEOUT_MS });
      this.socket = socket;

      const fail = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => fail(new Error('connect timeout')), CONNECT_TIMEOUT_MS);

      socket.on('connect_error', (err: Error) => fail(err));
      socket.on(NET_EVENTS.welcome, (w: WelcomeMsg) => {
        clearTimeout(timer);
        this.playerId = w.playerId;
        this.roomId = w.roomId;
        this.cb.onWelcome(w);
        resolve();
      });
      socket.on(NET_EVENTS.snapshot, (snap: WorldSnapshot) => {
        this.lastSnapshot = snap;
        this.cb.onSnapshot(snap);
      });
      socket.on(NET_EVENTS.crash, (msg: CrashMsg) => this.cb.onCrash(msg));
    });
  }

  /** Returns the exact input accepted into the prediction buffer, or null if it was not sent. */
  sendInput(input: ClientInput): InputMsg | null {
    const socket = this.socket;
    if (!socket || !socket.connected) return null;
    const now = performance.now();
    if (now - this.lastSend < 1000 / SEND_RATE) return null;
    this.lastSend = now;
    const msg: InputMsg = { ...input, seq: this.seq++ };
    socket.emit(NET_EVENTS.input, msg);
    return msg;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
