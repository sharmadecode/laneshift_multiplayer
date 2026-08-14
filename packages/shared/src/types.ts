/** Pure data shapes shared by server + client (no logic). */

/** Race length. `1` km is a hidden test mode used by harnesses, not the UI. */
export type RoomMode = 'endless' | 1 | 40 | 60 | 100;

export type RoomPhase = 'lobby' | 'countdown' | 'racing' | 'finished';

export interface RoomSettings {
  mode: RoomMode;
  /** Traffic density 0.55..1.3 (spawner multiplier). */
  density: number;
  seed?: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
}

export interface RoomStateMsg {
  roomId: string;
  code: string;
  hostId: string;
  phase: RoomPhase;
  settings: RoomSettings;
  /** Seconds remaining in the countdown; 0 outside countdown phase. */
  countdownT: number;
  players: LobbyPlayer[];
  /** Player ids in finish order; empty outside a finished match. */
  finished: string[];
}

export interface RankingEntry {
  playerId: string;
  name: string;
  rank: number;
  distance: number;
  /** Milliseconds from matchStart to crossing the line. */
  timeMs: number;
}

export interface TrafficCar {
  id: number;
  lane: number; // -1 | 0 | 1
  x: number; // absolute lateral position (m), lane center + drift
  roadDist: number; // absolute position on the road (meters)
  speed: number; // m/s
  length: number;
  width: number;
  modelIndex: number;
  colorIndex: number;
}
