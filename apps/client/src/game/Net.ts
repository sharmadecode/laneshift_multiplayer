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

// One input per server tick keeps the client-side grid prediction aligned
// with the server simulation (the server applies only the latest input per tick).
const SEND_RATE = TICK_RATE;

const LS_TOKEN = 'hr.token';
const LS_ROOM = 'hr.room'; // { roomId } we are entitled to rejoin

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
        this.cb.onWelcome(w);
        resolve();
        // Reclaim our race seat on every fresh connection (page reload or
        // socket.io reconnection) as long as we have not joined a room in this
        // session. The saved token survives the tab closing.
        const saved = loadRejoin();
        if (saved && saved.roomId && saved.roomId !== this.roomId) {
          this.rejoinRoom(saved.roomId, saved.token).then((r) => {
            if (!r.ok && (r.error === 'rejoin expired' || r.error === 'bad request')) {
              // Room gone or reservation expired: stop retrying on every reload.
              localStorage.removeItem(LS_ROOM);
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

  /** Auto-fill an open session; the server creates an endless room when none exists. */
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
    localStorage.removeItem(LS_ROOM);
  }

  /** Joined a room: from now on a dropped connection may rejoin it (45 s). */
  setRoom(roomId: string): void {
    this.roomId = roomId;
    localStorage.setItem(LS_ROOM, JSON.stringify({ roomId }));
  }

  private ack(event: string, payload: unknown): Promise<AckResult> {
    const socket = this.socket;
    if (!socket || !socket.connected) return Promise.resolve({ ok: false, error: 'not connected' });
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'no reply' });
      }, 4000);
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

  /**
   * Phase-lock input sends to the server tick schedule: a snapshot arrives
   * ~RTT/2 after each server tick, so sending exactly one tick period after
   * that lands each input in its own tick window. Without this, ~half of
   * server ticks see two inputs and collapse one — the client's prediction
   * then drifts from the authoritative trajectory and reconciliation fires
   * visible corrections.
   */
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
