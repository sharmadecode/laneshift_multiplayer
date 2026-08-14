// ---- Road / lane geometry ----
export const LANE_COUNT = 3;
export const LANE_WIDTH = 4.5; // meters per lane
export const SHOULDER_WIDTH = 1.2; // paved shoulder outside the outermost lanes
export const ROAD_HALF_WIDTH = (LANE_COUNT * LANE_WIDTH) / 2 + SHOULDER_WIDTH;

/** Maps lane index l (0..LANE_COUNT-1) to a symmetric lane coordinate (-1, 0, +1 for 3 lanes; -1, +1 for 2). */
export function laneCoordinate(l: number): number {
  if (LANE_COUNT <= 1) return 0;
  return (l / (LANE_COUNT - 1)) * 2 - 1;
}

export function laneCenterX(lane: number): number {
  return lane * LANE_WIDTH;
}

// ---- Player arcade physics ----
export const PLAYER_MAX_SPEED = 58; // m/s ~= 209 km/h
export const ACCELERATION = 11; // m/s^2
export const BRAKE_DECEL = 24;
export const DRAG_DECEL = 5;
export const LATERAL_SPEED = 12; // m/s lateral lane-change speed (at top speed)
export const STEER_RESPONSE = 10; // 1/s steering input smoothing rate
export const STEER_ROLL = 0.26; // rad body roll when steering
export const STEER_YAW = 0.2; // rad nose yaw when steering
export const START_SPEED = 20;

// ---- Traffic ----
export const TRAFFIC_SPEED_MIN = 15;
export const TRAFFIC_SPEED_MAX = 28;
export const TRAFFIC_AHEAD_WINDOW = 430; // spawn window ahead of the player (m)
export const TRAFFIC_MIN_SPAWN_AHEAD = 120; // never spawn closer than this (m)
export const TRAFFIC_REAR_WINDOW = 70; // despawn distance behind the player (m)
export const TRAFFIC_MAX_COUNT = 24;
export const TRAFFIC_BASE_GAP = 55; // meters between cars in the same lane
export const TRAFFIC_GAP_JITTER = 22;
export const TRAFFIC_FOLLOW_GAP = 14; // min same-lane following distance (m)
export const TRAFFIC_TAIL_SLOW = 0.8; // extra slowdown factor for dangerously close cars
export const TRAFFIC_LANE_DRIFT = 0.8; // max lateral drift inside a lane. Bounded so adjacent-lane cars never block a visible gap: 4.5 - 2*0.8 = 2.9 > max box pair 2.805, i.e. a corridor that looks open is always passable, and one that is blocked always looks blocked (models touch or overlap).
export const TRAFFIC_DENSITY_MIN = 0.55;
export const TRAFFIC_DENSITY_MAX = 1.3;

// ---- Multi-anchor traffic (personal packs for stranded racers) ----
export const TRAFFIC_PACK_PER_LANE = 3; // cars per lane in one personal pack seed
export const TRAFFIC_PACK_COOLDOWN_MS = 8000; // min gap between seeds for one racer
export const TRAFFIC_PACK_STRANDED = 530; // m behind the traffic front before seeding (window + margin)
export const TRAFFIC_PACK_NEAREST = 180; // m: seeds never appear closer than this (fog-hidden)
export const TRAFFIC_MAX_CARS = 60; // absolute hard cap on cars in one room
export const PLAYER_ACTIVE_SPEED = 5; // m/s: above this a racer is "racing"
export const PLAYER_IDLE_SPEED = 2; // m/s: below this a racer drifts toward inactive
export const PLAYER_IDLE_GRACE = 4; // s: sustained idle before excluded from lead/trail
export const JOIN_BEHIND_TRAIL_M = 100; // late-join spawn distance behind the trailing racer

// ---- Crash / respawn ----
export const CRASH_TIME = 3.0; // respawn delay after crash (s)
export const GHOST_TIME = 1.2; // no-collision grace after respawn (s)

// ---- Car collision box (2D) ----
export const CAR_LENGTH = 4.4;
export const CAR_WIDTH = 1.9;
export const COLLISION_SCALE = 0.72; // forgiveness factor: crash fires only after visible body overlap

// Player lateral clamp — stays inside the outermost lanes so traffic can always collide.
export const LANE_RANGE = (LANE_COUNT - 1) * (LANE_WIDTH / 2) + LANE_WIDTH / 2 - CAR_WIDTH / 2 - 0.25;

export const MS_TO_KMH = 3.6;
