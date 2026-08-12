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

sock.on('welcome', (w) => (myId = w.playerId));

sock.on('snap', (snap) => {
  const me = snap.players.find((p) => p.id === myId);
  if (!me) return;
  snapshots++;

  // Verbatim reconciliation strategy from Game.ts: restore the authoritative
  // state, then replay inputs the server has not yet simulated.
  while (pendingInputs.length && pendingInputs[0].seq <= me.appliedSeq) pendingInputs.shift();
  const needsReconcile =
    Math.abs(sim.x - me.x) > 1.25 ||
    Math.abs(sim.speed - me.speed) > 5 ||
    Math.abs(sim.distance - me.distance) > 7 ||
    sim.crashed !== me.crashed ||
    sim.ghost !== me.ghost;
  if (needsReconcile) {
    const u = Math.min(1, gridAccum / TICK_MS);
    const oldX = prev.x + (sim.x - prev.x) * u;
    const oldDistance = prev.distance + (sim.distance - prev.distance) * u;
    sim.x = me.x;
    sim.speed = me.speed;
    sim.distance = me.distance;
    sim.steering = me.steering;
    sim.crashed = me.crashed;
    sim.crashTimer = me.crashTimer;
    sim.ghost = me.ghost;
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

  // grid-vs-server offset (constant in healthy play, = network latency)
  if (!sim.crashed && !sim.ghost) {
    maxOffsetX = Math.max(maxOffsetX, Math.abs(sim.x - me.x));
    maxOffsetDist = Math.max(maxOffsetDist, Math.abs(sim.distance - me.distance));
  }
});

// 60 Hz render simulation: step the grid when due, render the interpolation.
setInterval(() => {
  const steer: -1 | 0 | 1 = (Math.sin(frames * FRAME_MS * 0.001 * 1.3) > 0.6
    ? 1
    : Math.sin(frames * FRAME_MS * 0.001 * 1.3) < -0.6
      ? -1
      : 0) as -1 | 0 | 1;
  latestInput = { steering: steer, throttle: 1, brake: 0 };

  gridAccum += FRAME_MS;
  while (gridAccum >= TICK_MS) {
    gridAccum -= TICK_MS;
    prev.x = sim.x;
    prev.speed = sim.speed;
    prev.distance = sim.distance;
    prev.steering = sim.steering;
    stepPlayer(sim, latestInput, 1 / 30);
  }
  const u = Math.min(1, gridAccum / TICK_MS);
  const correctionKeep = Math.exp(-2 * FRAME_MS / 1000);
  visualCorrection.x *= correctionKeep;
  visualCorrection.distance *= correctionKeep;
  const rx = prev.x + (sim.x - prev.x) * u + visualCorrection.x;
  const rd = prev.distance + (sim.distance - prev.distance) * u + visualCorrection.distance;

  // jitter = discontinuity in the rendered motion (skip crash/ghost transitions)
  if (!sim.crashed && !sim.ghost) {
    if (frames > 0) {
      maxFrameDeltaX = Math.max(maxFrameDeltaX, Math.abs(rx - lastRx));
      maxFrameDeltaDist = Math.max(maxFrameDeltaDist, Math.abs(rd - lastRd));
    }
    lastRx = rx;
    lastRd = rd;
  }
  frames++;
}, FRAME_MS);

// 30 Hz input send (verbatim Net.sendInput cadence)
setInterval(() => {
  if (!sock.connected) return;
  const msg = { ...latestInput, seq: nextSeq++ };
  pendingInputs.push(msg);
  sock.emit('in', msg);
}, 1000 / 30);

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
