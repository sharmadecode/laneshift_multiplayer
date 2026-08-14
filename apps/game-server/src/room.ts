import {
  COUNTDOWN_SECONDS,
  GHOST_TIME,
  LANE_COUNT,
  NET_EVENTS,
  NAME_MAX_LEN,
  PLAYER_ACTIVE_SPEED,
  PLAYER_IDLE_GRACE,
  PLAYER_IDLE_SPEED,
  RECONNECT_GRACE_MS,
  RESULT_LOBBY_MS,
  ROOM_MAX_PLAYERS,
  SNAPSHOT_RATE,
  TICK_RATE,
  TRAFFIC_PACK_COOLDOWN_MS,
  TRAFFIC_PACK_STRANDED,
  laneCenterX,
  laneCoordinate,
  type ClientInput,
  type InputMsg,
  type LobbyPlayer,
  type PlayerSnapshot,
  type RoomPhase,
  type RoomSettings,
  type RoomStateMsg,
  type WorldSnapshot
} from '@hr/shared';
import {
  TrafficSpawner,
  crash,
  createVehicle,
  playerHitsTraffic,
  stepPlayer,
  type VehicleState
} from '@hr/simulation';
import type { MatchResultMsg } from '@hr/shared';

const DT = 1 / TICK_RATE;
const SNAP_INTERVAL = 1 / SNAPSHOT_RATE;
const ROOM_SEED = 12345;

interface ServerPlayer {
  id: string;
  name: string;
  state: VehicleState;
  input: ClientInput;
  receivedSeq: number; // latest seq received (not necessarily stepped yet)
  appliedSeq: number; // latest seq whose input the sim has actually stepped
  active: boolean; // racing (or within the idle grace window)
  inactiveFor: number; // seconds spent below PLAYER_IDLE_SPEED
  lastPackSeed: number; // Date.now() of the last personal pack seed
  finished: boolean;
}

function idle(): ClientInput {
  return { steering: 0, throttle: 0, brake: 1 };
}

/**
 * One authoritative match. Phases: lobby -> countdown -> racing -> finished
 * (-> back to lobby via rematch or a short result hold). Runs on the fixed
 * 30 Hz tick; broadcasts 20 Hz snapshots while racing.
 */
export class Room {
  readonly players = new Map<string, ServerPlayer>();
  readonly code: string;
  phase: RoomPhase = 'lobby';
  hostId = '';
  settings: RoomSettings = { mode: 40, density: 0.8 };
  /** Reconnect seats: playerId -> expiry (Date.now() ms). Set on mid-race disconnect. */
  readonly reservations = new Map<string, number>();
  /** Player ids in finish order. */
  readonly finishOrder: string[] = [];
  /** Last match result; replayed to a rejoining player who missed the broadcast. */
  lastResult: MatchResultMsg | null = null;

  private spawner = new TrafficSpawner({ density: this.settings.density, seed: ROOM_SEED });
  private tickCount = 0;
  private snapTimer = 0;
  private clock = 0; // accumulated sim seconds (all phases)
  private countdownT = 0;
  private countdownAcc = 0;
  private matchClockStart = 0;
  private resultHoldUntil = 0;
  private lastReservationSweep = 0;

  constructor(
    private broadcast: (event: string, payload: unknown) => void,
    code: string
  ) {
    this.code = code;
  }

  /** Lobby/countdown joins: everyone starts at the line. */
  addPlayer(id: string, name: string): ServerPlayer {
    const p = this.spawnPlayer(id, name);
    this.players.set(id, p);
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
    return p;
  }

  /**
   * Racing/finished joins (quick join or code join): spawn behind the tail of
   * the field — at the last racer still crossing — ghosted for GHOST_TIME so
   * the newcomer can't crash on traffic right at the spawn point.
   */
  addJoiner(id: string, name: string): ServerPlayer {
    const p = this.spawnPlayer(id, name);
    const back = this.backOfField();
    if (back) {
      p.state.distance = back.state.distance;
      p.state.speed = back.state.speed;
    }
    p.state.ghost = true;
    p.state.ghostTimer = GHOST_TIME;
    this.players.set(id, p);
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
    return p;
  }

  /**
   * Spawn lane for the n-th seat in the room: lanes cycle 0,1,2 and same-lane
   * pairs get a half-lane lateral split, so up to 6 racers never stack at the
   * identical line position (players don't collide with each other, so an
   * identical spawn would look glued together until someone steers away).
   */
  private spawnX(index: number): number {
    const lane = index % LANE_COUNT;
    const shift = (Math.floor(index / LANE_COUNT) - 0.5) * 1.4;
    return laneCenterX(laneCoordinate(lane)) + shift;
  }

  private spawnPlayer(id: string, name: string): ServerPlayer {
    return {
      id,
      name: name.slice(0, NAME_MAX_LEN),
      state: { ...createVehicle(), x: this.spawnX(this.players.size) },
      input: idle(),
      receivedSeq: -1,
      appliedSeq: -1,
      active: true,
      inactiveFor: 0,
      lastPackSeed: 0,
      finished: false
    };
  }

  /** Lowest distance among racers still crossing (finished cars are past the line). */
  private backOfField(): ServerPlayer | null {
    let back: ServerPlayer | null = null;
    for (const p of this.players.values()) {
      if (p.finished) continue;
      if (!back || p.state.distance < back.state.distance) back = p;
    }
    return back;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    this.reservations.delete(id);
    this.broadcast(NET_EVENTS.playerLeave, { playerId: id });
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
    if (!this.players.size) this.spawner.reset(); // fresh deterministic world next match
    else if (this.hostId === id) this.promoteHost();
  }

  /** Mid-race socket loss keeps the seat for RECONNECT_GRACE_MS; lobby/countdown drops are permanent. */
  onDisconnect(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'racing' || this.phase === 'finished') {
      p.input = idle(); // the car coasts to a stop; traffic unpins via the idle rule
      this.reservations.set(id, Date.now() + RECONNECT_GRACE_MS);
    } else {
      this.removePlayer(id);
    }
  }

  /** True while a disconnected seat is still reclaimable. */
  isReserved(id: string): boolean {
    const until = this.reservations.get(id);
    return until !== undefined && until > Date.now();
  }

  /**
   * Evict the oldest reserved seats (mid-race dropouts) until a new player
   * fits. Reserved seats are a transient grace, not a right: a full room must
   * stay playable for newcomers, and the evicted player's token simply expires
   * ('rejoin expired' on their next attempt).
   */
  makeRoomFor(): boolean {
    while (this.players.size >= ROOM_MAX_PLAYERS && this.reservations.size > 0) {
      this.removePlayer(this.reservations.keys().next().value as string);
    }
    return this.players.size < ROOM_MAX_PLAYERS;
  }

  /** Rejoin success: the socket is rebound to the same ServerPlayer, so no state reset. */
  clearReservation(id: string): void {
    this.reservations.delete(id);
  }

  setInput(id: string, msg: InputMsg): void {
    const p = this.players.get(id);
    if (!p) return;
    p.input.steering = msg.steering;
    p.input.throttle = msg.throttle;
    p.input.brake = msg.brake;
    if (msg.seq > p.receivedSeq) p.receivedSeq = msg.seq;
  }

  /** Host-only. Transitions lobby -> countdown with the chosen settings. */
  startCountdown(settings: RoomSettings): void {
    this.settings = settings;
    this.spawner = new TrafficSpawner({ density: settings.density, seed: ROOM_SEED });
    this.phase = 'countdown';
    this.countdownT = COUNTDOWN_SECONDS;
    this.countdownAcc = 0;
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
  }

  /** Host-only. finished -> lobby, same players and settings, finish state cleared. */
  rematch(): void {
    if (this.phase !== 'finished') return;
    this.toLobby();
  }

  playerList(): PlayerSnapshot[] {
    return [...this.players.values()].map((p) => this.toPlayerSnapshot(p));
  }

  lobbyPlayers(): LobbyPlayer[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, isHost: p.id === this.hostId }));
  }

  toRoomState(): RoomStateMsg {
    return {
      roomId: this.code,
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      countdownT: this.countdownT,
      players: this.lobbyPlayers(),
      finished: [...this.finishOrder]
    };
  }

  tick(dt: number = DT): void {
    this.tickCount++;
    this.clock += dt;

    if (this.phase === 'lobby') return; // no world state until the match starts
    if (!this.players.size) return;

    if (this.phase === 'countdown') {
      this.countdownAcc += dt;
      while (this.countdownAcc >= 1) {
        this.countdownAcc -= 1;
        this.countdownT -= 1;
        if (this.countdownT <= 0) {
          this.beginMatch();
          return;
        }
        this.broadcast(NET_EVENTS.countdown, { t: this.countdownT });
      }
      return;
    }

    // racing / finished: full simulation
    const racers: Array<{ distance: number; active: boolean }> = [];
    for (const p of this.players.values()) {
      stepPlayer(p.state, p.input, dt);
      p.appliedSeq = p.receivedSeq;
      if (p.state.speed > PLAYER_ACTIVE_SPEED) {
        p.inactiveFor = 0;
      } else if (p.state.speed > PLAYER_IDLE_SPEED) {
        p.inactiveFor = Math.max(0, p.inactiveFor - dt);
      } else {
        p.inactiveFor += dt;
      }
      p.active = p.state.speed > PLAYER_ACTIVE_SPEED || p.inactiveFor < PLAYER_IDLE_GRACE;
      racers.push({ distance: p.state.distance, active: p.active });
    }

    this.spawner.update(racers, dt);

    const front = this.spawner.front;
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.active) continue;
      if (p.state.distance + TRAFFIC_PACK_STRANDED >= front) continue;
      if (now - p.lastPackSeed < TRAFFIC_PACK_COOLDOWN_MS) continue;
      this.spawner.seedPack(p.state.distance);
      p.lastPackSeed = now;
    }

    for (const p of this.players.values()) {
      if (p.state.crashed || p.state.ghost) continue;
      playerHitsTraffic(p.state.x, this.spawner.cars, p.state.distance, (car) => {
        crash(p.state);
        this.broadcast(NET_EVENTS.crash, { playerId: p.id, x: car.x });
      });
    }

    if (this.phase === 'racing') this.checkFinishes();

    this.snapTimer += dt;
    if (this.snapTimer >= SNAP_INTERVAL) {
      this.snapTimer -= SNAP_INTERVAL;
      this.broadcast(NET_EVENTS.snapshot, this.toSnapshot());
    }

    if (this.phase === 'finished' && this.clock >= this.resultHoldUntil) {
      this.toLobby();
      return;
    }

    // Expire reconnect seats. Sweep throttling keeps the work bounded.
    if (now - this.lastReservationSweep > 1000) {
      this.lastReservationSweep = now;
      for (const [id, until] of this.reservations) {
        if (until <= now) this.removePlayer(id);
      }
    }
  }

  private beginMatch(): void {
    let seat = 0;
    for (const p of this.players.values()) {
      p.state = { ...createVehicle(), x: this.spawnX(seat) };
      seat++;
      p.input = idle();
      p.receivedSeq = -1;
      p.appliedSeq = -1;
      p.active = true;
      p.inactiveFor = 0;
      p.lastPackSeed = 0;
      p.finished = false;
    }
    this.finishOrder.length = 0;
    this.matchClockStart = this.clock;
    this.lastResult = null; // a rejoin during the next match must not replay this one's result
    this.phase = 'racing';
    this.spawner.reset(); // fresh deterministic field from the line
    this.broadcast(NET_EVENTS.matchStart, {});
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
  }

  private checkFinishes(): void {
    const target = this.settings.mode === 'endless' ? Infinity : this.settings.mode * 1000;
    if (!Number.isFinite(target)) return;
    // Reserved seats (mid-race disconnect) can no longer cross the line, so
    // they must not hold the match hostage until the reservation expires.
    const expected = this.players.size - this.reservations.size;
    let allDone = true;
    // Racers parked long enough to lose the active flag (below PLAYER_IDLE_SPEED
    // for the full PLAYER_IDLE_GRACE) forfeit: without this, one AFK or crashed-
    // and-unattended car stops on the road, never crosses the line, and everyone
    // else waits on the finish overlay forever. They rank after the finishers.
    const dnf: ServerPlayer[] = [];
    for (const p of this.players.values()) {
      if (p.finished || this.reservations.has(p.id)) continue;
      if (p.state.distance >= target) {
        p.finished = true;
        this.finishOrder.push(p.id);
        const timeMs = Math.round((this.clock - this.matchClockStart) * 1000);
        this.broadcast(NET_EVENTS.finish, {
          playerId: p.id,
          rank: this.finishOrder.length,
          timeMs
        });
      } else if (p.active) {
        allDone = false;
      } else {
        dnf.push(p);
      }
    }
    // End the match once every finisher crossed and every non-finished racer is
    // idle — but never with zero finishers (a match everyone silently no-shows
    // just keeps running, like endless).
    if (allDone && this.finishOrder.length > 0 && this.finishOrder.length + dnf.length === expected) {
      this.phase = 'finished';
      this.resultHoldUntil = this.clock + RESULT_LOBBY_MS / 1000;
      const rankings = this.finishOrder.map((id, i) => {
        const p = this.players.get(id);
        return {
          playerId: id,
          name: p?.name ?? '?',
          rank: i + 1,
          distance: p?.state.distance ?? 0,
          timeMs: Math.round((this.clock - this.matchClockStart) * 1000)
        };
      });
      for (let i = 0; i < dnf.length; i++) {
        rankings.push({
          playerId: dnf[i].id,
          name: dnf[i].name,
          rank: this.finishOrder.length + i + 1,
          distance: dnf[i].state.distance,
          timeMs: -1 // DNF
        });
      }
      this.lastResult = { rankings, mode: this.settings.mode };
      this.broadcast(NET_EVENTS.matchResult, this.lastResult);
      this.broadcast(NET_EVENTS.roomState, this.toRoomState());
    }
  }

  private toLobby(): void {
    this.phase = 'lobby';
    this.countdownT = 0;
    this.countdownAcc = 0;
    this.finishOrder.length = 0;
    this.lastResult = null;
    // Drop seats still reserved when the match ends: their sockets are gone and
    // the lobby must not be haunted by phantoms that block new players.
    for (const id of [...this.reservations.keys()]) this.removePlayer(id);
    this.reservations.clear();
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
  }

  private promoteHost(): void {
    const next = this.players.keys().next().value;
    if (next !== undefined) {
      this.hostId = next;
      this.broadcast(NET_EVENTS.hostChanged, { hostId: this.hostId });
      this.broadcast(NET_EVENTS.roomState, this.toRoomState());
    }
  }

  private toSnapshot(): WorldSnapshot {
    const traffic = this.spawner.cars.map((c) => ({
      id: c.id,
      lane: c.lane,
      x: c.x,
      roadDist: c.roadDist,
      speed: c.speed,
      length: c.length,
      width: c.width,
      modelIndex: c.modelIndex,
      colorIndex: c.colorIndex
    }));
    return {
      tick: this.tickCount,
      ts: Date.now(),
      players: this.playerList(),
      traffic
    };
  }

  private toPlayerSnapshot(p: ServerPlayer): PlayerSnapshot {
    const s = p.state;
    return {
      id: p.id,
      name: p.name,
      x: s.x,
      speed: s.speed,
      distance: s.distance,
      steering: s.steering,
      crashed: s.crashed,
      crashTimer: s.crashTimer,
      ghost: s.ghost,
      appliedSeq: p.appliedSeq
    };
  }
}
