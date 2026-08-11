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
export const TRAFFIC_LANE_DRIFT = 0.85; // max lateral drift inside a lane (closes the between-lane dead strip)
export const TRAFFIC_DENSITY_MIN = 0.55;
export const TRAFFIC_DENSITY_MAX = 1.3;

// ---- Crash / respawn ----
export const CRASH_TIME = 3.0; // respawn delay after crash (s)
export const GHOST_TIME = 1.2; // no-collision grace after respawn (s)

// ---- Car collision box (2D) ----
export const CAR_LENGTH = 4.4;
export const CAR_WIDTH = 1.9;
export const COLLISION_SCALE = 0.82; // forgiveness factor

// Player lateral clamp — stays inside the outermost lanes so traffic can always collide.
export const LANE_RANGE = (LANE_COUNT - 1) * (LANE_WIDTH / 2) + LANE_WIDTH / 2 - CAR_WIDTH / 2 - 0.25;

export const MS_TO_KMH = 3.6;
