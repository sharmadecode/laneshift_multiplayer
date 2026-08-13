import { io, type Socket } from 'socket.io-client';

// Multi-anchor traffic acceptance (pack rule set from PLAN):
//  A drives for the whole window; B parks for 12 s, then throttles.
//  Assert:
//   1. no starvation: while B is parked (inactive), A's window [A, A+700]
//      never drops below 8 cars in any snapshot
//   2. seed latency: within 2 s of B moving again, B has >= 3 cars within
//      [B, B+430]
//   3. no overlaps: every snapshot, same-lane cars keep >= 10 m spacing
//      (the only visible flicker source during pack merges)
//   4. bounds: car count never exceeds 60 and no non-finite roadDist
//   5. parity: same-tick snapshots from A and B carry identical traffic
const URL = 'http://localhost:5200';

interface SnapLike {
  tick: number;
  ts: number;
  players: Array<{ id: string; x: number; speed: number; distance: number; crashed: boolean; ghost: boolean }>;
  traffic: Array<{ id: number; lane: number; x: number; roadDist: number; speed: number }>;
}

const T0 = Date.now();
const elapsed = (): number => (Date.now() - T0) / 1000;

interface Tracker {
  id: string;
  s: Socket;
  count: number;
  byTick: Map<number, SnapLike>;
  lastSnap: SnapLike | null;
  steerEvery: number;
  steerN: number;
}

function mkClient(tag: string, steerEvery: number, script: (n: number, t: number) => { steering: -1 | 0 | 1; throttle: number; brake: number }): Tracker {
  const s = io(URL, { transports: ['websocket'] });
  const tr: Tracker = { id: '', s, count: 0, byTick: new Map(), lastSnap: null, steerEvery, steerN: 0 };
  s.on('welcome', (w: { playerId: string }) => (tr.id = w.playerId));
  s.on('snap', (snap: SnapLike) => {
    tr.count++;
    tr.lastSnap = snap;
    tr.byTick.set(snap.tick, snap);
    for (const k of tr.byTick.keys()) if (snap.tick - k > 240) tr.byTick.delete(k);
  });
  s.on('connect', () => {
    setInterval(() => {
      if (!s.connected) return;
      const t = elapsed();
      tr.steerN++;
      s.emit('in', { ...script(tr.steerN, t), seq: tr.steerN });
    }, 33);
  });
  return tr;
}

const a = mkClient(
  'A',
  6,
  (n) => ({
    steering: n % 6 === 0 ? (Math.random() > 0.5 ? 1 : -1) : 0,
    throttle: 1,
    brake: 0
  })
);
const b = mkClient(
  'B',
  12,
  (_n, t) => {
    if (t < 12) return { steering: _n % 12 === 0 ? (Math.random() > 0.5 ? 1 : -1) : 0, throttle: 1, brake: 0 };
    if (t < 15) return { steering: 0, throttle: 0, brake: 1 };
    if (t < 24) return { steering: 0, throttle: 0, brake: 0 };
    return { steering: _n % 6 === 0 ? (Math.random() > 0.5 ? 1 : -1) : 0, throttle: 1, brake: 0 };
  }
);

// A-side observer: starvation, overlaps, bounds, B-resume seed latency
let minCarsWhileBParked = Infinity;
let starvationFails = 0;
let bWasParked = false;
let bResumeSpeedAt = 0; // elapsed s when B first exceeds 5 m/s after the park
let bSeedLatencyMs: number | null = null;
let overlapViolations = 0;
let maxCount = 0;
let nonFinite = 0;

a.s.on('snap', (snap: SnapLike) => {
  const me = snap.players.find((p) => p.id === a.id);
  const bPlayer = snap.players.find((p) => p.id === b.id);
  if (!me || !bPlayer) return;

  maxCount = Math.max(maxCount, snap.traffic.length);
  for (const c of snap.traffic) {
    if (!Number.isFinite(c.roadDist) || !Number.isFinite(c.x) || !Number.isFinite(c.speed)) nonFinite++;
  }

  // same-lane spacing (lanes are coordinates -1, 0, +1)
  for (const lane of [-1, 0, 1]) {
    const laneCars = snap.traffic.filter((c) => c.lane === lane).sort((p, q) => q.roadDist - p.roadDist);
    for (let i = 1; i < laneCars.length; i++) {
      if (laneCars[i - 1].roadDist - laneCars[i].roadDist < 10) overlapViolations++;
    }
  }

  const parked = !bPlayer.crashed && bPlayer.speed < 2 && elapsed() > 14 && elapsed() < 24;
  if (parked) {
    bWasParked = true;
    const inWindow = snap.traffic.filter((c) => c.roadDist > me.distance && c.roadDist < me.distance + 700).length;
    minCarsWhileBParked = Math.min(minCarsWhileBParked, inWindow);
    if (inWindow < 8) starvationFails++;
  }

  // B resume: first speed > 5 after the park phase, then measure seed latency
  if (!bResumeSpeedAt && elapsed() > 24 && bPlayer.speed > 5) {
    bResumeSpeedAt = elapsed();
  }
  if (bResumeSpeedAt && bSeedLatencyMs === null) {
    const ahead = snap.traffic.filter((c) => c.roadDist > bPlayer.distance && c.roadDist < bPlayer.distance + 430).length;
    if (ahead >= 3) bSeedLatencyMs = Math.round((elapsed() - bResumeSpeedAt) * 1000);
  }
});

// parity: same-tick traffic from A and B must be identical
setTimeout(() => {
  let compared = 0;
  let mismatches = 0;
  for (const [tick, snapB] of b.byTick) {
    const snapA = a.byTick.get(tick);
    if (!snapA) continue;
    compared++;
    if (JSON.stringify(snapA.traffic) !== JSON.stringify(snapB.traffic)) mismatches++;
  }

  const dur = elapsed();
  console.log(`A: ${a.count} snapshots (${(a.count / dur).toFixed(1)}/s), B: ${b.count} snapshots (${(b.count / dur).toFixed(1)}/s)`);
  console.log(`no starvation while B parked: min cars in A window = ${minCarsWhileBParked === Infinity ? 'n/a' : minCarsWhileBParked}, fails = ${starvationFails}`);
  console.log(`B resume seed latency: ${bSeedLatencyMs === null ? 'never seeded!' : bSeedLatencyMs + ' ms'} (B resumed moving at ${bResumeSpeedAt.toFixed(1)}s)`);
  console.log(`overlap violations (same-lane gap < 10 m): ${overlapViolations}`);
  console.log(`bounds: max cars = ${maxCount} (limit 60), non-finite positions = ${nonFinite}`);
  console.log(`traffic parity: ${compared} same-tick comparisons, mismatches = ${mismatches}`);
  const ok =
    bWasParked &&
    starvationFails === 0 &&
    bSeedLatencyMs !== null &&
    bSeedLatencyMs <= 2000 &&
    overlapViolations === 0 &&
    maxCount <= 60 &&
    nonFinite === 0 &&
    mismatches === 0;
  console.log(ok ? 'PASS: multi-anchor traffic (no starvation, instant seed, no overlaps)' : 'FAIL: multi-anchor traffic');
  a.s.close();
  b.s.close();
  process.exit(ok ? 0 : 1);
}, 36000);
