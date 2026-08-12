import type { TrafficCar } from './types.js';

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
  roomId: string;
  players: PlayerSnapshot[];
}

export interface CrashMsg {
  playerId: string;
  x: number; // world x of the crash, for FX on every client
}

export interface PlayerLeaveMsg {
  playerId: string;
}

export const NET_EVENTS = {
  input: 'in',
  welcome: 'welcome',
  snapshot: 'snap',
  playerJoin: 'pj',
  playerLeave: 'pl',
  crash: 'crash'
} as const;

// ---- Limits ----

export const INPUT_RATE_MAX = 60; // per second, per player (server drops the rest)
export const SNAPSHOT_RATE = 20; // snapshots per second
export const TICK_RATE = 30; // server simulation ticks per second
export const CONNECT_TIMEOUT_MS = 2500;
