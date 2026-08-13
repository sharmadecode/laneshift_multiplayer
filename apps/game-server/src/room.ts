import {
  GHOST_TIME,
  JOIN_BEHIND_TRAIL_M,
  NET_EVENTS,
  PLAYER_ACTIVE_SPEED,
  PLAYER_IDLE_GRACE,
  PLAYER_IDLE_SPEED,
  SNAPSHOT_RATE,
  START_SPEED,
  TICK_RATE,
  TRAFFIC_PACK_COOLDOWN_MS,
  TRAFFIC_PACK_STRANDED,
  type ClientInput,
  type InputMsg,
  type PlayerSnapshot,
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
}

/**
 * One authoritative world. Owns the traffic sim and every player's physics.
 * Runs on the fixed 30 Hz tick; broadcasts 20 Hz snapshots.
 */
export class Room {
  readonly players = new Map<string, ServerPlayer>();
  private spawner = new TrafficSpawner({ density: 0.8, seed: ROOM_SEED });
  private tickCount = 0;
  private snapTimer = 0;

  constructor(
    private broadcast: (event: string, payload: unknown) => void,
    readonly id: string
  ) {}

  addPlayer(id: string, name: string): ServerPlayer {
    const state = createVehicle();
    // Late joiners spawn behind the trailing racer, ghost-protected until
    // they reach the pack (ghost = intangible; GHOST_TIME long enough to
    // cover the gap but short enough to feel fair).
    let trail = Infinity;
    for (const p of this.players.values()) {
      if (p.state.distance < trail) trail = p.state.distance;
    }
    state.distance = Math.max(0, (trail === Infinity ? 0 : trail) - JOIN_BEHIND_TRAIL_M);
    state.speed = START_SPEED * 0.6;
    state.ghost = true;
    state.ghostTimer = GHOST_TIME;
    const p: ServerPlayer = {
      id,
      name,
      state,
      input: { steering: 0, throttle: 0, brake: 0 },
      // Sequence zero is a valid first input, so use -1 until one is received.
      receivedSeq: -1,
      appliedSeq: -1,
      active: true,
      inactiveFor: 0,
      lastPackSeed: 0
    };
    this.players.set(id, p);
    this.broadcast(NET_EVENTS.playerJoin, this.toPlayerSnapshot(p));
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    // An empty room has no world worth keeping: the next player gets a fresh,
    // deterministic field (also a structural guard against stale debris).
    if (!this.players.size) this.spawner.reset();
    this.broadcast(NET_EVENTS.playerLeave, { playerId: id });
  }

  setInput(id: string, msg: InputMsg): void {
    const p = this.players.get(id);
    if (!p) return;
    p.input.steering = msg.steering;
    p.input.throttle = msg.throttle;
    p.input.brake = msg.brake;
    if (msg.seq > p.receivedSeq) p.receivedSeq = msg.seq;
  }

  playerList(): PlayerSnapshot[] {
    return [...this.players.values()].map((p) => this.toPlayerSnapshot(p));
  }

  tick(dt: number = DT): void {
    this.tickCount++;
    if (!this.players.size) return; // no world state to keep while empty

    const racers: Array<{ distance: number; active: boolean }> = [];
    for (const p of this.players.values()) {
      stepPlayer(p.state, p.input, dt);
      // The snapshot state is stepped through the latest received input, so
      // echo that seq — clients replay only inputs beyond it (exact prediction).
      p.appliedSeq = p.receivedSeq;
      // Idle racers stop pinning the world: hysteresis keeps a brief stop
      // (crash, lift-off) racing, and a parked player drops out after a few
      // seconds so the leader's traffic keeps flowing.
      if (p.state.speed > PLAYER_ACTIVE_SPEED) {
        p.inactiveFor = 0;
      } else if (p.state.speed > PLAYER_IDLE_SPEED) {
        p.inactiveFor = Math.max(0, p.inactiveFor - dt); // creeping: recover slowly
      } else {
        p.inactiveFor += dt;
      }
      p.active = p.state.speed > PLAYER_ACTIVE_SPEED || p.inactiveFor < PLAYER_IDLE_GRACE;
      racers.push({ distance: p.state.distance, active: p.active });
    }

    this.spawner.update(racers, dt);

    // Personal packs: a racing player stranded behind the traffic front gets
    // cars seeded around them (rate-limited) — this is what makes a parked
    // player who throttles after 5 minutes meet traffic instantly, and what
    // fills the road for mid-race joiners.
    const front = this.spawner.front;
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.active) continue;
      if (p.state.distance + TRAFFIC_PACK_STRANDED >= front) continue; // not stranded
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

    this.snapTimer += dt;
    if (this.snapTimer >= SNAP_INTERVAL) {
      // Preserve the remainder. Resetting to zero produced 15 Hz snapshots
      // from a 30 Hz simulation instead of the intended 20 Hz average.
      this.snapTimer -= SNAP_INTERVAL;
      this.broadcast(NET_EVENTS.snapshot, this.toSnapshot());
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
