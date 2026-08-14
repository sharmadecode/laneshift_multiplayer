import type { RoomSettings, TrafficCar } from './types.js';

// ---- Client -> Server ----

/** Control input. Clients NEVER send position/speed/collisions as truth. */
export interface ClientInput {
  steering: -1 | 0 | 1;
  throttle: number; // 0..1
  brake: number; // 0..1
}

export interface InputMsg extends ClientInput {
  seq: number; // monotonically increasing, used for prediction reconciliation
}

export interface CreateRoomMsg {
  name: string;
}

export interface JoinRoomMsg {
  code: string;
  name: string;
}

export interface RejoinRoomMsg {
  roomId: string;
  token: string;
}

export interface QuickJoinMsg {
  name: string;
}

export interface StartMatchMsg {
  settings: RoomSettings;
}

// ---- Server -> Client ----

export interface PlayerSnapshot {
  id: string;
  name: string;
  x: number;
  speed: number;
  distance: number;
  steering: number;
  crashed: boolean;
  crashTimer: number;
  ghost: boolean;
  /** Highest input seq that the sim state in this snapshot has actually stepped. */
  appliedSeq: number;
}

export interface WorldSnapshot {
  tick: number; // server tick (30 Hz)
  ts: number; // Date.now() on the server, for latency/interpolation
  players: PlayerSnapshot[];
  traffic: TrafficCar[];
}

export interface WelcomeMsg {
  playerId: string;
}

export interface CrashMsg {
  playerId: string;
  x: number; // world x of the crash, for FX on every client
}

export interface PlayerLeaveMsg {
  playerId: string;
}

export interface CountdownMsg {
  t: number; // 5..1
}

export interface FinishMsg {
  playerId: string;
  rank: number;
  timeMs: number;
}

export interface MatchResultMsg {
  rankings: Array<{
    playerId: string;
    name: string;
    rank: number;
    distance: number;
    timeMs: number;
  }>;
  mode: RoomSettings['mode'];
}

export interface HostChangedMsg {
  hostId: string;
}

export const NET_EVENTS = {
  input: 'in',
  createRoom: 'createRoom',
  joinRoom: 'joinRoom',
  quickJoin: 'quickJoin',
  rejoinRoom: 'rejoinRoom',
  startMatch: 'startMatch',
  rematch: 'rematch',
  leaveRoom: 'leaveRoom',
  welcome: 'welcome',
  roomState: 'roomState',
  snapshot: 'snap',
  countdown: 'countdown',
  matchStart: 'matchStart',
  playerJoin: 'pj',
  playerLeave: 'pl',
  crash: 'crash',
  finish: 'finish',
  matchResult: 'matchResult',
  hostChanged: 'hostChanged'
} as const;

// ---- Limits ----

export const INPUT_RATE_MAX = 60; // per second, per player (server drops the rest)
export const SNAPSHOT_RATE = 20; // snapshots per second
export const TICK_RATE = 30; // server simulation ticks per second
export const CONNECT_TIMEOUT_MS = 2500;

export const ROOM_MAX_PLAYERS = 6;
export const ROOM_CODE_LEN = 5;
/** No 0/O/1/I/L — typable and unambiguous. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const NAME_MAX_LEN = 16;
export const COUNTDOWN_SECONDS = 5;
export const RECONNECT_GRACE_MS = 45000;
export const RESULT_LOBBY_MS = 8000;
export const DENSITY_MIN = 0.55;
export const DENSITY_MAX = 1.3;
export const ROOM_JOIN_RATE_MAX = 5; // create/join attempts per minute per socket
export const REJOIN_RATE_MAX = 10; // per minute per socket
/** Modes the UI offers; the harness-only 1 km mode is deliberately absent. */
export const ROOM_MODES: RoomSettings['mode'][] = ['endless', 40, 60, 100];
