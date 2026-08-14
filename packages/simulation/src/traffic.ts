import {
  CAR_LENGTH,
  CAR_WIDTH,
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
  TRAFFIC_DENSITY_MIN,
  TRAFFIC_DENSITY_MAX,
  laneCenterX,
  laneCoordinate
} from '@hr/shared';
import type { TrafficCar } from '@hr/shared';

export type { TrafficCar };

/** Seeded PRNG (mulberry32) for deterministic simulation across peers. */
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
  density: number;
  seed?: number;
}

export class TrafficSpawner {
  cars: TrafficCar[] = [];
  private nextId = 1;
  private nextSpawn: number[] = [];
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

  get front(): number {
    let f = -Infinity;
    for (const c of this.cars) if (c.roadDist > f) f = c.roadDist;
    return f;
  }

  private maxCars(): number {
    return Math.min(TRAFFIC_MAX_COUNT + 12 * (this.lastActiveCount - 1), TRAFFIC_MAX_CARS);
  }

  /** Advances traffic simulation by dt, following the leading active racer. */
  update(racers: Array<{ distance: number; active: boolean }>, dt: number): void {
    if (!racers.length) return;
    const active = racers.filter((r) => r.active);
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
        this.nextSpawn[l] = lead + TRAFFIC_AHEAD_WINDOW * 0.6 + this.rng() * TRAFFIC_AHEAD_WINDOW * 0.4;
        this.spawnAhead(l);
      }
      this.initialised = true;
    }

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

    // Car-following behavior
    for (let l = 0; l < LANE_COUNT; l++) {
      const lane = this.cars.filter((c) => c.lane === laneCoordinate(l));
      lane.sort((a, b) => b.roadDist - a.roadDist);
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

    // Forward spawn generation
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

  /** Seeds a traffic pack ahead of a trailing or rejoining racer without overlap. */
  seedPack(distance: number): void {
    const far = distance + TRAFFIC_AHEAD_WINDOW;
    const start = distance + TRAFFIC_PACK_NEAREST;
    for (let l = 0; l < LANE_COUNT; l++) {
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
      if (occupied) continue;
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

  private pushCar(laneIndex: number, roadDist: number): void {
    const modelIndex = Math.floor(this.rng() * 18);
    // Authentic speed profiles across 18 unique vehicle archetypes
    let minSpd = TRAFFIC_SPEED_MIN;
    let maxSpd = TRAFFIC_SPEED_MAX;
    if (modelIndex === 0) {
      // Nissan GT-R Track Monster (128 - 148 km/h)
      minSpd = 35.5; maxSpd = 41.0;
    } else if (modelIndex === 1) {
      // Aero Supercar / Lambo (124 - 142 km/h)
      minSpd = 34.5; maxSpd = 39.5;
    } else if (modelIndex === 2) {
      // Highway Patrol Police Interceptor (122 - 140 km/h)
      minSpd = 34.0; maxSpd = 39.0;
    } else if (modelIndex === 3) {
      // Mazda RX-7 Rotary Sports (120 - 138 km/h)
      minSpd = 33.5; maxSpd = 38.5;
    } else if (modelIndex === 4) {
      // Dodge Challenger V8 Muscle (118 - 135 km/h)
      minSpd = 33.0; maxSpd = 37.5;
    } else if (modelIndex === 5) {
      // 180SX Drift Tuner (112 - 128 km/h)
      minSpd = 31.0; maxSpd = 35.5;
    } else if (modelIndex === 6) {
      // Sports Convertible (110 - 126 km/h)
      minSpd = 30.5; maxSpd = 35.0;
    } else if (modelIndex === 7) {
      // Toyota Trueno AE86 (106 - 124 km/h)
      minSpd = 29.5; maxSpd = 34.5;
    } else if (modelIndex === 8) {
      // Ignition GT Coupe (102 - 118 km/h)
      minSpd = 28.5; maxSpd = 33.0;
    } else if (modelIndex === 9) {
      // Classic V8 Muscle (98 - 114 km/h)
      minSpd = 27.0; maxSpd = 31.5;
    } else if (modelIndex === 10) {
      // Emergency Ambulance (95 - 112 km/h)
      minSpd = 26.5; maxSpd = 31.0;
    } else if (modelIndex === 11) {
      // Executive Sport Sedan (92 - 108 km/h)
      minSpd = 25.5; maxSpd = 30.0;
    } else if (modelIndex === 12) {
      // Family Sedan (84 - 98 km/h)
      minSpd = 23.5; maxSpd = 27.5;
    } else if (modelIndex === 13) {
      // Pastel Sedan (80 - 95 km/h)
      minSpd = 22.0; maxSpd = 26.5;
    } else if (modelIndex === 14) {
      // Metropolis Taxi (78 - 92 km/h)
      minSpd = 21.5; maxSpd = 25.5;
    } else if (modelIndex === 15) {
      // City Yellow Taxi (74 - 88 km/h)
      minSpd = 20.5; maxSpd = 24.5;
    } else if (modelIndex === 16) {
      // Mitsubishi L200 Pickup Truck (72 - 86 km/h)
      minSpd = 20.0; maxSpd = 24.0;
    } else {
      // Urban SUV / Minivan (68 - 82 km/h)
      minSpd = 19.0; maxSpd = 23.0;
    }

    const speed = minSpd + this.rng() * (maxSpd - minSpd);
    const isBig = modelIndex === 10 || modelIndex === 16 || modelIndex === 17;
    const isSport = modelIndex <= 8;
    this.cars.push({
      id: this.nextId++,
      lane: laneCoordinate(laneIndex),
      x: laneCenterX(laneCoordinate(laneIndex)) + (this.rng() * 2 - 1) * TRAFFIC_LANE_DRIFT,
      roadDist,
      speed,
      length: CAR_LENGTH * (isBig ? 1.15 : isSport ? 0.96 : 1.0),
      width: CAR_WIDTH * (isBig ? 1.08 : 1.0),
      modelIndex,
      colorIndex: Math.floor(this.rng() * 8)
    });
  }

  private spawnAhead(laneIndex: number): void {
    const gap = (TRAFFIC_BASE_GAP + this.rng() * TRAFFIC_GAP_JITTER) * (1.2 - 0.4 * this.density);
    const roadDist = this.nextSpawn[laneIndex];
    this.pushCar(laneIndex, roadDist);
    this.nextSpawn[laneIndex] = roadDist + gap;
  }
}

export function relZ(car: TrafficCar, playerDist: number): number {
  return -(car.roadDist - playerDist);
}

export function absZ(car: TrafficCar, playerDist: number): number {
  return playerDist - car.roadDist;
}

function clamp01(x: number): number {
  return Math.max(TRAFFIC_DENSITY_MIN, Math.min(TRAFFIC_DENSITY_MAX, x));
}
