import {
  CAR_LENGTH,
  CAR_WIDTH,
  COLLISION_SCALE,
  LANE_COUNT,
  TRAFFIC_AHEAD_WINDOW,
  TRAFFIC_BASE_GAP,
  TRAFFIC_GAP_JITTER,
  TRAFFIC_MAX_COUNT,
  TRAFFIC_MAX_CARS,
  TRAFFIC_MIN_SPAWN_AHEAD,
  TRAFFIC_LANE_DRIFT,
  TRAFFIC_FOLLOW_GAP,
  TRAFFIC_PACK_NEAREST,
  TRAFFIC_PACK_PER_LANE,
  TRAFFIC_REAR_WINDOW,
  TRAFFIC_SPEED_MAX,
  TRAFFIC_SPEED_MIN,
  TRAFFIC_TAIL_SLOW,
  laneCenterX,
  laneCoordinate
} from '@hr/shared';
import type { TrafficCar } from '@hr/shared';

export type { TrafficCar };

/** Seeded PRNG (mulberry32) so traffic is deterministic when a seed is given. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TrafficOptions {
  density: number; // 0..1 scale of traffic amount
  seed?: number;
}

export class TrafficSpawner {
  cars: TrafficCar[] = [];
  private nextId = 1;
  private nextSpawn: number[] = []; // absolute roadDist where to spawn next, per lane
  private rng: () => number;
  private density: number;
  private initialised = false;
  private lastActiveCount = 1;

  constructor(opts: TrafficOptions = { density: 0.7 }) {
    this.rng = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random;
    this.density = clamp01(opts.density);
  }

  reset(density?: number): void {
    if (density !== undefined) this.density = clamp01(density);
    this.cars = [];
    this.nextId = 1;
    this.nextSpawn = [];
    this.initialised = false;
    this.lastActiveCount = 1;
  }

  /** Highest roadDist in the field (the traffic front). */
  get front(): number {
    let f = -Infinity;
    for (const c of this.cars) if (c.roadDist > f) f = c.roadDist;
    return f;
  }

  /** Soft cap: scales with the number of racers actually racing. */
  private maxCars(): number {
    return Math.min(TRAFFIC_MAX_COUNT + 12 * (this.lastActiveCount - 1), TRAFFIC_MAX_CARS);
  }

  /**
   * Advance the traffic simulation by dt seconds. `racers` is every player in
   * the room with their distance and activity state: the world follows the
   * leading *active* racer, and cars despawn only behind the trailing active
   * racer (an idle player must not pin the world). Every client sees the same
   * cars because this single field is what snapshots carry.
   */
  update(racers: Array<{ distance: number; active: boolean }>, dt: number): void {
    if (!racers.length) return; // an empty room must never seed the world
    const active = racers.filter((r) => r.active);
    // No one racing (all parked): keep the world coherent off everyone's
    // positions instead of letting -Infinity poison the spawn cursors.
    const tracked = active.length ? active : racers;
    let lead = -Infinity;
    let trail = Infinity;
    for (const r of tracked) {
      if (r.distance > lead) lead = r.distance;
      if (r.distance < trail) trail = r.distance;
    }
    this.lastActiveCount = Math.max(1, active.length);

    if (!this.initialised) {
      for (let l = 0; l < LANE_COUNT; l++) {
        this.nextSpawn[l] = lead + TRAFFIC_AHEAD_WINDOW * 0.25 + this.rng() * TRAFFIC_AHEAD_WINDOW * 0.75;
        this.spawnAhead(l);
      }
      this.initialised = true;
    }

    // move cars forward; drop ones behind the trailing racer or stranded far
    // ahead of the leading racer (debris from departed players, never legit:
    // the refill keeps the front inside lead + window)
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      c.roadDist += c.speed * dt;
      if (
        trail - c.roadDist > TRAFFIC_REAR_WINDOW ||
        c.roadDist - lead > TRAFFIC_AHEAD_WINDOW + 300
      ) {
        this.cars.splice(i, 1);
      }
    }

    // same-lane car following: a slower car ahead caps the one behind,
    // and already-overlapping cars slow down extra until they separate
    for (let l = 0; l < LANE_COUNT; l++) {
      const lane = this.cars.filter((c) => c.lane === laneCoordinate(l));
      lane.sort((a, b) => b.roadDist - a.roadDist); // front to back
      for (let i = 1; i < lane.length; i++) {
        const front = lane[i - 1];
        const back = lane[i];
        const gap = front.roadDist - back.roadDist;
        if (gap < TRAFFIC_FOLLOW_GAP) {
          back.speed = Math.min(back.speed, front.speed);
        }
        if (gap < TRAFFIC_FOLLOW_GAP * 0.5) {
          back.speed = Math.min(back.speed, front.speed * TRAFFIC_TAIL_SLOW);
        }
      }
    }

    // spawn more as the window advances; never spawn too close to the leader
    // or behind the lane's frontmost car (which can catch up while the cap pauses spawning)
    for (let l = 0; l < LANE_COUNT; l++) {
      const lane = this.cars.filter((c) => c.lane === laneCoordinate(l));
      let frontmost = -Infinity;
      for (const c of lane) if (c.roadDist > frontmost) frontmost = c.roadDist;
      const minSpawn = Math.max(
        lead + TRAFFIC_MIN_SPAWN_AHEAD,
        frontmost + TRAFFIC_FOLLOW_GAP + 2
      );
      if (this.nextSpawn[l] < minSpawn) this.nextSpawn[l] = minSpawn;
      while (this.cars.length < this.maxCars() && this.nextSpawn[l] - lead < TRAFFIC_AHEAD_WINDOW) {
        this.spawnAhead(l);
      }
    }
  }

  /**
   * Seed a personal pack of traffic ahead of a racer stranded behind the
   * traffic front (late joiners, parked-then-go racers, slow starters).
   * Lanes whose range [d+180, d+430] already holds cars are skipped, so a pack
   * can never overlap existing traffic — when the packs merge, no new cars
   * appear and the existing ones just flow together.
   */
  seedPack(distance: number): void {
    const far = distance + TRAFFIC_AHEAD_WINDOW;
    const start = distance + TRAFFIC_PACK_NEAREST;
    for (let l = 0; l < LANE_COUNT; l++) {
      // Only cars in the local window matter: the leader's cars far ahead
      // must not block the stranded racer's seed.
      let occupied = false;
      for (const c of this.cars) {
        if (
          c.lane === laneCoordinate(l) &&
          c.roadDist > start - TRAFFIC_FOLLOW_GAP - 10 &&
          c.roadDist < far + TRAFFIC_FOLLOW_GAP
        ) {
          occupied = true;
          break;
        }
      }
      if (occupied) continue; // range occupied: merging packs never overlap
      let pos = start;
      let placed = 0;
      while (
        placed < TRAFFIC_PACK_PER_LANE &&
        pos < far &&
        this.cars.length < this.maxCars()
      ) {
        this.pushCar(l, pos);
        pos += TRAFFIC_BASE_GAP * (0.9 + this.rng() * 0.4) * (1.2 - 0.4 * this.density);
        placed++;
      }
    }
  }

  /** Remove every car within clearAhead of the player (used after respawn). */
  clearNear(playerDist: number, range: number): void {
    this.cars = this.cars.filter(
      (c) => Math.abs(c.roadDist - playerDist) > range
    );
    for (let l = 0; l < LANE_COUNT; l++) {
      if (this.nextSpawn[l] < playerDist + TRAFFIC_MIN_SPAWN_AHEAD) {
        this.nextSpawn[l] = playerDist + TRAFFIC_MIN_SPAWN_AHEAD;
      }
    }
  }

  /** Create a car at an explicit position (refill cursor or personal pack). */
  private pushCar(laneIndex: number, roadDist: number): void {
    const speed = TRAFFIC_SPEED_MIN + this.rng() * (TRAFFIC_SPEED_MAX - TRAFFIC_SPEED_MIN);
    this.cars.push({
      id: this.nextId++,
      lane: laneCoordinate(laneIndex),
      x: laneCenterX(laneCoordinate(laneIndex)) + (this.rng() * 2 - 1) * TRAFFIC_LANE_DRIFT,
      roadDist,
      speed,
      length: CAR_LENGTH * (0.95 + this.rng() * 0.15),
      width: CAR_WIDTH * (0.95 + this.rng() * 0.1),
      modelIndex: Math.floor(this.rng() * 4),
      colorIndex: Math.floor(this.rng() * 8)
    });
  }

  /** Spawn one car at the lane index's cursor; each lane advances its own cursor. */
  private spawnAhead(laneIndex: number): void {
    const gap = (TRAFFIC_BASE_GAP + this.rng() * TRAFFIC_GAP_JITTER) * (1.2 - 0.4 * this.density);
    const roadDist = this.nextSpawn[laneIndex];
    this.pushCar(laneIndex, roadDist);
    this.nextSpawn[laneIndex] = roadDist + gap;
  }
}

/** Relative z of a traffic car to the player (negative = ahead of player). */
export function relZ(car: TrafficCar, playerDist: number): number {
  return -(car.roadDist - playerDist);
}

/** Render z of a traffic car. Player sits at z = 0. Ahead = -Z. */
export function absZ(car: TrafficCar, playerDist: number): number {
  return playerDist - car.roadDist;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
