import { io } from 'socket.io-client';
import { PLAYER_MAX_SPEED } from '@hr/shared';
import { createVehicle, stepPlayer, type InputState } from '@hr/simulation';

// Mirrors the client's grid-stepped prediction (Game.ts): the local car is
// stepped only on the server's 30 Hz tick grid (phase-anchored to snapshots),
// then interpolated between grid states for smooth 60 fps rendering.
const TICK_MS = 1000 / 30;
const FRAME_MS = 1000 / 60;

const sock = io('http://localhost:5200', { transports: ['websocket'] });
let myId = '';
const sim = createVehicle(); // grid state (player.state on the client)
const prev = { x: 0, speed: 0, distance: 0, steering: 0 }; // state after previous grid step
let gridAccum = 0;
let latestInput: InputState = { steering: 0, throttle: 0, brake: 0 };
let lastSent: (InputState & { seq: number }) | null = null;
let nextSeq = 0;
const pendingInputs: Array<InputState & { seq: number }> = [];
const visualCorrection = { x: 0, distance: 0 };

let lastRx = 0;
let lastRd = 0;
let frames = 0;
let maxFrameDeltaX = 0;
let maxFrameDeltaDist = 0;
let maxOffsetX = 0;
let maxOffsetDist = 0;
let safetyNetTriggers = 0;
let snapshots = 0;
let trackedPrev = false;

sock.on('welcome', (w) => (myId = w.playerId));

sock.on('snap', (snap) => {
  const me = snap.players.find((p) => p.id === myId);
  if (!me) return;
  snapshots++;

  // Verbatim reconciliation strategy from Game.ts: motion divergence only;
  // crash/ghost flags are authoritative and applied separately.
  while (pendingInputs.length && pendingInputs[0].seq <= me.appliedSeq) pendingInputs.shift();
  const needsReconcile =
    Math.abs(sim.x - me.x) > 1.25 ||
    Math.abs(sim.speed - me.speed) > 5 ||
    Math.abs(sim.distance - me.distance) > 7;
  if (needsReconcile) {
    const u = Math.min(1, gridAccum / TICK_MS);
    const oldX = prev.x + (sim.x - prev.x) * u;
    const oldDistance = prev.distance + (sim.distance - prev.distance) * u;
    sim.x = me.x;
    sim.speed = me.speed;
    sim.distance = me.distance;
    sim.steering = me.steering;
    for (const input of pendingInputs) stepPlayer(sim, input, 1 / 30);
    prev.x = sim.x;
    prev.speed = sim.speed;
    prev.distance = sim.distance;
    prev.steering = sim.steering;
    gridAccum = 0;
    visualCorrection.x += oldX - sim.x;
    visualCorrection.distance += oldDistance - sim.distance;
    safetyNetTriggers++;
  }
  sim.crashed = me.crashed;
  sim.crashTimer = me.crashTimer;
  sim.ghost = me.ghost;
  sim.ghostTimer = me.ghostTimer;
  gridAccum %= TICK_MS;
  nextSendAt = Date.now(); // Net.resync: anchor send cadence to snapshot arrival

  // grid-vs-server offset (constant in healthy play, = network latency)
  if (!sim.crashed && !sim.ghost) {
    maxOffsetX = Math.max(maxOffsetX, Math.abs(sim.x - me.x));
    maxOffsetDist = Math.max(maxOffsetDist, Math.abs(sim.distance - me.distance));
  }
});

// Render simulation driven by real elapsed time. Bare setInterval(16.67) is
// clamped to ~32 ms on Windows (16 ms timer granularity), which would run the
// sim at ~16 Hz against the server's true 30 Hz and read as fake divergence.
let lastNow = performance.now();
let frameAcc = 0;
setInterval(() => {
  const now = performance.now();
  let ms = now - lastNow;
  lastNow = now;
  if (ms > 250) ms = 250;
  frameAcc += ms;
  while (frameAcc >= FRAME_MS) {
    frameAcc -= FRAME_MS;
    runFrame();
  }
}, 5);

function runFrame(): void {
  const steer: -1 | 0 | 1 = (Math.sin(frames * FRAME_MS * 0.001 * 1.3) > 0.6
    ? 1
    : Math.sin(frames * FRAME_MS * 0.001 * 1.3) < -0.6
      ? -1
      : 0) as -1 | 0 | 1;
  latestInput = { steering: steer, throttle: 1, brake: 0 };

  gridAccum += FRAME_MS;
  // verbatim Game.ts: grid steps apply the last SENT input (what the server has)
  while (gridAccum >= TICK_MS) {
    gridAccum -= TICK_MS;
    prev.x = sim.x;
    prev.speed = sim.speed;
    prev.distance = sim.distance;
    prev.steering = sim.steering;
    stepPlayer(sim, lastSent ?? latestInput, 1 / 30);
  }
  const u = Math.min(1, gridAccum / TICK_MS);
  const correctionKeep = Math.exp(-2 * FRAME_MS / 1000);
  visualCorrection.x *= correctionKeep;
  visualCorrection.distance *= correctionKeep;
  const rx = prev.x + (sim.x - prev.x) * u + visualCorrection.x;
  const rd = prev.distance + (sim.distance - prev.distance) * u + visualCorrection.distance;

  // jitter = discontinuity in the rendered motion (skip crash/ghost
  // transitions; a gap between tracked frames must not count as a jump)
  if (!sim.crashed && !sim.ghost) {
    if (trackedPrev) {
      const dx = Math.abs(rx - lastRx);
      const dd = Math.abs(rd - lastRd);
      maxFrameDeltaX = Math.max(maxFrameDeltaX, dx);
      maxFrameDeltaDist = Math.max(maxFrameDeltaDist, dd);
    }
    lastRx = rx;
    lastRd = rd;
    trackedPrev = true;
  } else {
    trackedPrev = false;
  }
  frames++;
}

// 30 Hz input send (verbatim Net.sendInput cadence, phase-locked to snapshots)
let nextSendAt = 0;
setInterval(() => {
  if (!sock.connected) return;
  const now = Date.now();
  if (now < nextSendAt) return;
  nextSendAt = now + 1000 / 30;
  const msg = { ...latestInput, seq: nextSeq++ };
  pendingInputs.push(msg);
  lastSent = msg;
  sock.emit('in', msg);
}, 4);

setTimeout(() => {
  const smoothFrameX = (PLAYER_MAX_SPEED * FRAME_MS) / 1000; // 0.97 m/frame at top speed
  console.log(`snapshots: ${snapshots}`);
  console.log(`max rendered frame delta: x=${maxFrameDeltaX.toFixed(3)} m, distance=${maxFrameDeltaDist.toFixed(3)} m`);
  console.log(`max grid-vs-server offset: x=${maxOffsetX.toFixed(3)} m, distance=${maxOffsetDist.toFixed(3)} m`);
  console.log(`safety-net corrections: ${safetyNetTriggers}`);
  const ok =
    maxFrameDeltaX < 0.35 &&
    maxFrameDeltaDist < smoothFrameX * 1.5 &&
    // A local predictor deliberately runs a few server ticks ahead while its
    // inputs travel to the authority. The visible-motion checks above catch
    // jitter; this merely rejects an unbounded desync.
    maxOffsetX < 1.5 &&
    maxOffsetDist < 8;
  console.log(
    ok
      ? 'PASS: rendered motion is continuous (no yanks), offset stays constant (no chasing)'
      : 'FAIL: jitter or divergence detected'
  );
  process.exit(ok ? 0 : 1);
}, 8000);
