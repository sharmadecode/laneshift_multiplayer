import {
  NET_EVENTS,
  SNAPSHOT_RATE,
  TICK_RATE,
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
    const p: ServerPlayer = {
      id,
      name,
      state: createVehicle(),
      input: { steering: 0, throttle: 0, brake: 0 },
      // Sequence zero is a valid first input, so use -1 until one is received.
      receivedSeq: -1,
      appliedSeq: -1
    };
    this.players.set(id, p);
    this.broadcast(NET_EVENTS.playerJoin, this.toPlayerSnapshot(p));
    return p;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
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

    const dists: number[] = [];
    for (const p of this.players.values()) {
      stepPlayer(p.state, p.input, dt);
      // The snapshot state is stepped through the latest received input, so
      // echo that seq — clients replay only inputs beyond it (exact prediction).
      p.appliedSeq = p.receivedSeq;
      dists.push(p.state.distance);
    }

    this.spawner.update(dists, dt);

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
