import {
  CAR_LENGTH,
  CAR_WIDTH,
  COLLISION_SCALE,
  LANE_COUNT,
  TRAFFIC_AHEAD_WINDOW,
  TRAFFIC_BASE_GAP,
  TRAFFIC_GAP_JITTER,
  TRAFFIC_MAX_COUNT,
  TRAFFIC_MIN_SPAWN_AHEAD,
  TRAFFIC_LANE_DRIFT,
  TRAFFIC_FOLLOW_GAP,
  TRAFFIC_TAIL_SLOW,
  TRAFFIC_REAR_WINDOW,
  TRAFFIC_SPEED_MAX,
  TRAFFIC_SPEED_MIN,
  laneCenterX,
  laneCoordinate
} from '@hr/shared';

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
  }

  /** Advance the traffic simulation by dt seconds. playerDist = player road distance. */
  update(playerDist: number, dt: number): void {
    if (!this.initialised) {
      for (let l = 0; l < LANE_COUNT; l++) {
        this.nextSpawn[l] = playerDist + TRAFFIC_AHEAD_WINDOW * 0.25 + this.rng() * TRAFFIC_AHEAD_WINDOW * 0.75;
        this.spawnAhead(laneCoordinate(l));
      }
      this.initialised = true;
    }

    // move cars forward
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      c.roadDist += c.speed * dt;
      if (playerDist - c.roadDist > TRAFFIC_REAR_WINDOW) {
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

    // spawn more as the window advances; never spawn too close to the player
    // or behind the lane's frontmost car (which can catch up while the cap pauses spawning)
    for (let l = 0; l < LANE_COUNT; l++) {
      const lane = this.cars.filter((c) => c.lane === laneCoordinate(l));
      let frontmost = -Infinity;
      for (const c of lane) if (c.roadDist > frontmost) frontmost = c.roadDist;
      const minSpawn = Math.max(
        playerDist + TRAFFIC_MIN_SPAWN_AHEAD,
        frontmost + TRAFFIC_FOLLOW_GAP + 2
      );
      if (this.nextSpawn[l] < minSpawn) this.nextSpawn[l] = minSpawn;
      while (this.cars.length < TRAFFIC_MAX_COUNT && this.nextSpawn[l] - playerDist < TRAFFIC_AHEAD_WINDOW) {
        this.spawnAhead(laneCoordinate(l));
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

  private spawnAhead(lane: number): void {
    const gap = (TRAFFIC_BASE_GAP + this.rng() * TRAFFIC_GAP_JITTER) * (1.2 - 0.4 * this.density);
    const roadDist = this.nextSpawn[lane + 1];
    const speed = TRAFFIC_SPEED_MIN + this.rng() * (TRAFFIC_SPEED_MAX - TRAFFIC_SPEED_MIN);
    this.cars.push({
      id: this.nextId++,
      lane,
      x: laneCenterX(lane) + (this.rng() * 2 - 1) * TRAFFIC_LANE_DRIFT,
      roadDist,
      speed,
      length: CAR_LENGTH * (0.95 + this.rng() * 0.15),
      width: CAR_WIDTH * (0.95 + this.rng() * 0.1),
      modelIndex: Math.floor(this.rng() * 4),
      colorIndex: Math.floor(this.rng() * 8)
    });
    this.nextSpawn[lane + 1] = roadDist + gap;
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
