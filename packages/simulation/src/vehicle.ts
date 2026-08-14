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
  STEER_RESPONSE,
  getTrackCurvature
} from '@hr/shared';

export interface InputState {
  steering: number; // -1..1
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

  // Real vehicle physical simulation attributes
  rpm: number; // Engine RPM (1000..8500)
  gear: number; // 1..7
  pitch: number; // Chassis pitch angle (rad, + dive on brake, - squat on throttle)
  roll: number; // Chassis roll angle (rad, lean into corners)
  lateralG: number; // Lateral G-force (-1.5 .. +1.5)
}

// 7-speed dual-clutch transmission speed thresholds (m/s)
const GEAR_SPEEDS = [0, 16.6, 27.8, 40.2, 52.7, 65.2, 76.4, 90.0];

export function createVehicle(): VehicleState {
  return {
    x: 0,
    speed: START_SPEED,
    distance: 0,
    steering: 0,
    crashed: false,
    crashTimer: 0,
    ghost: false,
    ghostTimer: 0,
    rpm: 1200,
    gear: 1,
    pitch: 0,
    roll: 0,
    lateralG: 0
  };
}

/** Realistic vehicle physics step with suspension spring dynamics, gear transmission & tire grip. */
export function stepPlayer(v: VehicleState, input: InputState, dt: number): VehicleState {
  if (v.crashed) {
    v.crashTimer -= dt;
    v.rpm = Math.max(800, v.rpm - 3000 * dt);
    v.pitch *= Math.max(0, 1 - 5 * dt);
    v.roll *= Math.max(0, 1 - 5 * dt);
    v.lateralG = 0;
    if (v.crashTimer <= 0) respawn(v);
    return v;
  }

  // --- 1. Longitudinal Acceleration with Powerband Torque ---
  let targetAccel = 0;
  if (input.brake > 0) {
    targetAccel = -BRAKE_DECEL * input.brake;
    v.speed = Math.max(0, v.speed + targetAccel * dt);
  } else if (input.throttle > 0) {
    if (v.speed < PLAYER_MAX_SPEED) {
      // High-speed aerodynamic resistance + torque curve
      const speedRatio = v.speed / PLAYER_MAX_SPEED;
      const powerMult = Math.max(0.35, 1.0 - 0.55 * Math.pow(speedRatio, 1.4));
      targetAccel = ACCELERATION * input.throttle * powerMult;
      v.speed = Math.min(PLAYER_MAX_SPEED, v.speed + targetAccel * dt);
    } else {
      v.speed = PLAYER_MAX_SPEED;
      targetAccel = 0;
    }
  } else {
    targetAccel = -DRAG_DECEL;
    v.speed = Math.max(0, v.speed - DRAG_DECEL * dt);
  }

  // --- 2. 7-Speed Transmission & RPM ---
  let curGear = 1;
  for (let g = 1; g < GEAR_SPEEDS.length - 1; g++) {
    if (v.speed >= GEAR_SPEEDS[g]) curGear = g + 1;
  }
  v.gear = curGear;

  const minSpeedInGear = GEAR_SPEEDS[curGear - 1];
  const maxSpeedInGear = GEAR_SPEEDS[curGear];
  const gearProgress = Math.max(0, Math.min(1, (v.speed - minSpeedInGear) / Math.max(1, maxSpeedInGear - minSpeedInGear)));
  const targetRpm = 2500 + gearProgress * 5500 + (input.throttle > 0 ? 500 * input.throttle : 0);
  v.rpm += (targetRpm - v.rpm) * (1 - Math.exp(-12 * dt));

  // --- 3. Dynamic Steering with High-Speed Stability & Tire Grip ---
  // High-speed speed factor tightens responsiveness for precision racing
  const speedNorm = v.speed / PLAYER_MAX_SPEED;
  const steerSensitivity = Math.max(0.65, 1.25 - 0.45 * speedNorm);
  const k = 1 - Math.exp(-STEER_RESPONSE * steerSensitivity * dt);
  const targetSteer = Math.max(-1, Math.min(1, input.steering));
  const oldSteer = v.steering;
  v.steering += (targetSteer - v.steering) * k;

  // Responsive arcade lateral control + road curve centrifugal force
  const speedGripFactor = Math.min(1.0, Math.max(0, (v.speed - 1.0) / 4.0));
  const lateralVel = v.steering * LATERAL_SPEED * (0.6 + 0.4 * speedNorm) * speedGripFactor;

  // Centrifugal force gently biases car outward on curves (subtle arcade cornering)
  const curve = getTrackCurvature(v.distance);
  const centrifugalForce = -curve * Math.pow(speedNorm, 1.2) * 1.2;

  v.x += (lateralVel + centrifugalForce) * dt;
  if (Math.abs(v.x) > LANE_RANGE) {
    v.x = Math.sign(v.x) * LANE_RANGE;
  }

  // Lateral G-Force calculation reflecting steering + curve inertia
  const steerDelta = (v.steering - oldSteer) / Math.max(0.001, dt);
  const rawLateralG = (v.steering * (v.speed / 28) + steerDelta * 0.08) + curve * (v.speed / 45);
  v.lateralG += (rawLateralG - v.lateralG) * (1 - Math.exp(-14 * dt));

  // --- 4. Suspension Spring-Damper Dynamics ---
  // Pitch: Throttle lifts front (+rad, squats rear), Braking dives front (-rad, lifts rear)
  const targetPitch = targetAccel > 2
    ? 0.025 * (targetAccel / ACCELERATION)
    : targetAccel < -2
    ? -0.032 * (Math.abs(targetAccel) / BRAKE_DECEL)
    : 0;
  v.pitch += (targetPitch - v.pitch) * (1 - Math.exp(-14 * dt));

  // Roll: Stiff sports anti-roll bar
  const targetRoll = -v.lateralG * 0.022;
  v.roll += (targetRoll - v.roll) * (1 - Math.exp(-14 * dt));

  // --- 5. Distance Traveled ---
  v.distance += v.speed * dt;

  // --- 6. Ghost Timer ---
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
  v.lateralG = 0;
}

function respawn(v: VehicleState): void {
  v.crashed = false;
  v.crashTimer = 0;
  v.ghost = true;
  v.ghostTimer = GHOST_TIME;
  v.speed = 10;
  v.pitch = 0;
  v.roll = 0;
  v.lateralG = 0;
}
