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
  getWeatherSpeedMultiplier,
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
  receivedSeq: number;
  appliedSeq: number;
  active: boolean;
  inactiveFor: number;
  lastPackSeed: number;
  finished: boolean;
}

function coast(): ClientInput {
  return { steering: 0, throttle: 0, brake: 0 };
}

function drive(): ClientInput {
  return { steering: 0, throttle: 1, brake: 0 };
}

/**
 * Authoritative room simulation.
 * Manages match lifecycle: Lobby -> Countdown -> Racing -> Finished.
 */
export class Room {
  readonly players = new Map<string, ServerPlayer>();
  readonly code: string;
  phase: RoomPhase = 'lobby';
  hostId = '';
  settings: RoomSettings = { mode: 40, density: 0.8 };
  readonly reservations = new Map<string, number>();
  readonly finishOrder: string[] = [];
  lastResult: MatchResultMsg | null = null;

  private spawner = new TrafficSpawner({ density: this.settings.density, seed: ROOM_SEED });
  private tickCount = 0;
  private snapTimer = 0;
  private clock = 0;
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

  /** Adds a player starting at the line during lobby or countdown. */
  addPlayer(id: string, name: string): ServerPlayer {
    const p = this.spawnPlayer(id, name);
    this.players.set(id, p);
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
    return p;
  }

  /** Adds a player mid-race at the back of the active pack with ghost protection. */
  addJoiner(id: string, name: string): ServerPlayer {
    const p = this.spawnPlayer(id, name);
    if (this.phase !== 'finished') {
      const back = this.backOfField();
      if (back) {
        p.state.distance = back.state.distance;
        p.state.speed = back.state.speed;
      }
      p.state.ghost = true;
      p.state.ghostTimer = GHOST_TIME;
    }
    this.players.set(id, p);
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
    return p;
  }

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
      input: coast(),
      receivedSeq: -1,
      appliedSeq: -1,
      active: true,
      inactiveFor: 0,
      lastPackSeed: 0,
      finished: false
    };
  }

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
    if (!this.players.size) this.spawner.reset();
    else if (this.hostId === id) this.promoteHost();
  }

  onDisconnect(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'racing' || this.phase === 'finished') {
      p.input = coast();
      this.reservations.set(id, Date.now() + RECONNECT_GRACE_MS);
    } else {
      this.removePlayer(id);
    }
  }

  isReserved(id: string): boolean {
    const until = this.reservations.get(id);
    return until !== undefined && until > Date.now();
  }

  makeRoomFor(): boolean {
    while (this.players.size >= ROOM_MAX_PLAYERS && this.reservations.size > 0) {
      this.removePlayer(this.reservations.keys().next().value as string);
    }
    return this.players.size < ROOM_MAX_PLAYERS;
  }

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

  startCountdown(settings: RoomSettings): void {
    this.settings = settings;
    this.spawner = new TrafficSpawner({ density: settings.density, seed: ROOM_SEED });
    this.phase = 'countdown';
    this.countdownT = COUNTDOWN_SECONDS;
    this.countdownAcc = 0;
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
  }

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

    if (this.phase === 'lobby') return;
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

    const racers: Array<{ distance: number; active: boolean }> = [];
    for (const p of this.players.values()) {
      const speedMult = getWeatherSpeedMultiplier(p.state.distance, 3000, this.settings.seed);
      stepPlayer(p.state, p.input, dt, speedMult);
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

    const leadDist = racers.length ? Math.max(...racers.map((r) => r.distance)) : 0;
    const trafficSpeedMult = getWeatherSpeedMultiplier(leadDist, 3000, this.settings.seed);
    this.spawner.update(racers, dt, trafficSpeedMult);

    const front = this.spawner.front;
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.active) continue;
      if (p.state.distance + TRAFFIC_PACK_STRANDED >= front) continue;
      if (now - p.lastPackSeed < TRAFFIC_PACK_COOLDOWN_MS) continue;
      this.spawner.seedPack(p.state.distance, trafficSpeedMult);
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
      p.input = coast();
      p.receivedSeq = -1;
      p.appliedSeq = -1;
      p.active = true;
      p.inactiveFor = 0;
      p.lastPackSeed = 0;
      p.finished = false;
    }
    this.finishOrder.length = 0;
    this.matchClockStart = this.clock;
    this.lastResult = null;
    this.phase = 'racing';
    this.spawner.reset();
    this.broadcast(NET_EVENTS.matchStart, {});
    this.broadcast(NET_EVENTS.roomState, this.toRoomState());
  }

  private checkFinishes(): void {
    const target = this.settings.mode === 'endless' ? Infinity : this.settings.mode * 1000;
    if (!Number.isFinite(target)) return;

    const expected = this.players.size - this.reservations.size;
    let allDone = true;
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
          timeMs: -1
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
