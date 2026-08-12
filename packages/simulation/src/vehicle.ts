import {
  ACCELERATION,
  BRAKE_DECEL,
  CRASH_TIME,
  DRAG_DECEL,
  GHOST_TIME,
  LATERAL_SPEED,
  LANE_RANGE,
  PLAYER_MAX_SPEED,
  START_SPEED,
  STEER_RESPONSE
} from '@hr/shared';

export interface InputState {
  steering: -1 | 0 | 1;
  throttle: number; // 0..1
  brake: number; // 0..1
}

export interface VehicleState {
  x: number; // lateral position (m, 0 = center lane)
  speed: number; // m/s (forward)
  distance: number; // meters driven
  steering: number; // smoothed steering (-1..1 float)
  crashed: boolean;
  crashTimer: number;
  ghost: boolean;
  ghostTimer: number;
}

export function createVehicle(): VehicleState {
  return {
    x: 0,
    speed: START_SPEED,
    distance: 0,
    steering: 0,
    crashed: false,
    crashTimer: 0,
    ghost: false,
    ghostTimer: 0
  };
}

/** Pure arcade physics step for the player car. Mutates and returns v. */
export function stepPlayer(v: VehicleState, input: InputState, dt: number): VehicleState {
  if (v.crashed) {
    v.crashTimer -= dt;
    if (v.crashTimer <= 0) respawn(v);
    return v;
  }

  // --- longitudinal ---
  if (input.throttle > 0 && v.speed < PLAYER_MAX_SPEED) {
    v.speed += ACCELERATION * input.throttle * dt;
  } else if (input.brake > 0) {
    v.speed -= BRAKE_DECEL * input.brake * dt;
  } else {
    v.speed -= DRAG_DECEL * dt;
  }
  v.speed = Math.max(0, Math.min(PLAYER_MAX_SPEED, v.speed));

  // --- lateral (smoothed steering: the car eases into lane changes) ---
  const k = 1 - Math.pow(Math.E, -STEER_RESPONSE * dt);
  v.steering += (input.steering - v.steering) * k;
  const speedFactor = 0.5 + 0.5 * (v.speed / PLAYER_MAX_SPEED);
  v.x += v.steering * LATERAL_SPEED * speedFactor * dt;
  if (Math.abs(v.x) > LANE_RANGE) v.x = Math.sign(v.x) * LANE_RANGE;

  // --- distance ---
  v.distance += v.speed * dt;

  // --- ghost timer ---
  if (v.ghost) {
    v.ghostTimer -= dt;
    if (v.ghostTimer <= 0) v.ghost = false;
  }
  return v;
}

export function crash(v: VehicleState): void {
  if (v.crashed || v.ghost) return;
  v.crashed = true;
  v.crashTimer = CRASH_TIME;
  v.speed = 0;
  v.steering = 0;
}

function respawn(v: VehicleState): void {
  v.crashed = false;
  v.crashTimer = 0;
  v.ghost = true;
  v.ghostTimer = GHOST_TIME;
  v.speed = START_SPEED * 0.6;
  v.x = 0;
}
