import { io, type Socket } from 'socket.io-client';
import {
  CONNECT_TIMEOUT_MS,
  NET_EVENTS,
  TICK_RATE,
  type ClientInput,
  type CountdownMsg,
  type CrashMsg,
  type FinishMsg,
  type HostChangedMsg,
  type InputMsg,
  type MatchResultMsg,
  type RoomSettings,
  type RoomStateMsg,
  type WelcomeMsg,
  type WorldSnapshot
} from '@hr/shared';

export interface NetCallbacks {
  onSnapshot: (snap: WorldSnapshot) => void;
  onCrash: (msg: CrashMsg) => void;
  onWelcome: (w: WelcomeMsg) => void;
  onRoomState: (s: RoomStateMsg) => void;
  onCountdown: (m: CountdownMsg) => void;
  onMatchStart: () => void;
  onFinish: (m: FinishMsg) => void;
  onMatchResult: (m: MatchResultMsg) => void;
  onHostChanged: (m: HostChangedMsg) => void;
  onDisconnect: () => void;
  onRejoinFailed: () => void;
}

interface AckResult {
  ok: boolean;
  error?: string;
  token?: string;
  roomId?: string;
  playerId?: string;
}

const SEND_RATE = TICK_RATE;
const LS_TOKEN = 'hr.token';
const LS_ROOM = 'hr.room';

/**
 * Resolves the Socket.IO server URL.
 * In production / Render: connects to the same origin.
 * In dev: points to port 5200.
 * In Capacitor Android: points to VITE_SERVER_URL.
 */
function serverUrl(): string | undefined {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  if (typeof location !== 'undefined' && location.port === '5199') {
    return `http://${location.hostname}:5200`;
  }
  return undefined;
}

export class Net {
  playerId = '';
  roomId = '';
  token = '';
  lastSnapshot: WorldSnapshot | null = null;
  connected = false;

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
      const socket = url
        ? io(url, { transports: ['websocket'], timeout: CONNECT_TIMEOUT_MS })
        : io({ transports: ['websocket'], timeout: CONNECT_TIMEOUT_MS });
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
        this.cb.onWelcome(w);
        resolve();

        const saved = loadRejoin();
        if (saved && saved.roomId && saved.roomId !== this.roomId) {
          this.rejoinRoom(saved.roomId, saved.token).then((r) => {
            if (!r.ok && (r.error === 'rejoin expired' || r.error === 'bad request')) {
              localStorage.removeItem(LS_ROOM);
              localStorage.removeItem(LS_TOKEN);
              this.cb.onRejoinFailed();
            }
          });
        }
      });

      socket.on(NET_EVENTS.snapshot, (snap: WorldSnapshot) => {
        this.lastSnapshot = snap;
        this.cb.onSnapshot(snap);
      });
      socket.on(NET_EVENTS.crash, (msg: CrashMsg) => this.cb.onCrash(msg));
      socket.on(NET_EVENTS.roomState, (s: RoomStateMsg) => this.cb.onRoomState(s));
      socket.on(NET_EVENTS.countdown, (m: CountdownMsg) => this.cb.onCountdown(m));
      socket.on(NET_EVENTS.matchStart, () => this.cb.onMatchStart());
      socket.on(NET_EVENTS.finish, (m: FinishMsg) => this.cb.onFinish(m));
      socket.on(NET_EVENTS.matchResult, (m: MatchResultMsg) => this.cb.onMatchResult(m));
      socket.on(NET_EVENTS.hostChanged, (m: HostChangedMsg) => this.cb.onHostChanged(m));
      socket.on('disconnect', () => {
        this.connected = false;
        this.cb.onDisconnect();
      });
      socket.on('connect', () => {
        this.connected = true;
      });
    });
  }

  createRoom(name: string): Promise<AckResult> {
    return this.ack(NET_EVENTS.createRoom, { name });
  }

  joinRoom(code: string, name: string): Promise<AckResult> {
    return this.ack(NET_EVENTS.joinRoom, { code, name });
  }

  quickJoin(name: string): Promise<AckResult> {
    return this.ack(NET_EVENTS.quickJoin, { name });
  }

  rejoinRoom(roomId: string, token: string): Promise<AckResult> {
    return this.ack(NET_EVENTS.rejoinRoom, { roomId, token });
  }

  startMatch(settings: RoomSettings): void {
    this.socket?.emit(NET_EVENTS.startMatch, { settings });
  }

  rematch(): void {
    this.socket?.emit(NET_EVENTS.rematch);
  }

  leaveRoom(): void {
    this.socket?.emit(NET_EVENTS.leaveRoom);
    this.roomId = '';
    this.token = '';
    localStorage.removeItem(LS_ROOM);
    localStorage.removeItem(LS_TOKEN);
  }

  private setRoom(roomId: string): void {
    this.roomId = roomId;
    localStorage.setItem(LS_ROOM, JSON.stringify({ roomId }));
  }

  private ack(event: string, payload: unknown): Promise<AckResult> {
    return new Promise((resolve) => {
      const socket = this.socket;
      if (!socket) {
        resolve({ ok: false, error: 'not connected' });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'timed out' });
      }, CONNECT_TIMEOUT_MS);

      socket.emit(event, payload, (r: AckResult | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const res = r ?? { ok: false, error: 'no reply' };
        if (res.ok && res.token) {
          this.token = res.token;
          localStorage.setItem(LS_TOKEN, this.token);
        }
        if (res.ok && res.playerId && res.roomId) {
          this.playerId = res.playerId;
          this.setRoom(res.roomId);
        }
        resolve(res);
      });
    });
  }

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

  resync(now: number): void {
    this.lastSend = now;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}

function loadRejoin(): { roomId: string; token: string } | null {
  const roomRaw = localStorage.getItem(LS_ROOM);
  const token = localStorage.getItem(LS_TOKEN);
  if (!roomRaw || !token) return null;
  try {
    const room = JSON.parse(roomRaw) as { roomId?: string };
    if (!room.roomId) return null;
    return { roomId: room.roomId, token };
  } catch {
    return null;
  }
}
