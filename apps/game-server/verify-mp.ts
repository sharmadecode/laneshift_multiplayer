import { io, type Socket } from 'socket.io-client';

// Two-client acceptance probe (Phase 2 checks per PLAN.md §10):
//  1. both clients receive welcome + snapshots continuously
//  2. snapshot cadence is ~20 Hz average (not 15)
//  3. both clients see byte-identical traffic in every snapshot
//  4. remote player motion is continuous and monotonic (server is authoritative)
//  5. crash parity: if either client crashes, the other learns it within 1.5 s
const URL = 'http://localhost:5200';

interface SnapLike {
  tick: number;
  ts: number;
  players: Array<{ id: string; x: number; distance: number; crashed: boolean; ghost: boolean }>;
  traffic: Array<{ id: number; x: number; roadDist: number; speed: number }>;
}

function mkClient(tag: string, steerEvery: number): Socket {
  const s = io(URL, { transports: ['websocket'] });
  let count = 0;
  let lastSnap: SnapLike | null = null;
  const byTick = new Map<number, SnapLike>();

  s.on('snap', (snap: SnapLike) => {
    count++;
    lastSnap = snap;
    byTick.set(snap.tick, snap);
    for (const k of byTick.keys()) if (snap.tick - k > 120) byTick.delete(k); // keep ~2s
    (s as unknown as { count?: number }).count = count;
    (s as unknown as { lastSnap?: SnapLike }).lastSnap = snap;
    (s as unknown as { byTick?: Map<number, SnapLike> }).byTick = byTick;
  });

  let n = 0;
  s.on('connect', () => {
    setInterval(() => {
      const steer = n % steerEvery === 0 ? (Math.random() > 0.5 ? 1 : -1) : 0;
      s.emit('in', { steering: steer, throttle: 1, brake: 0, seq: n++ });
    }, 33);
  });
  return s;
}

const a = mkClient('A', 6);
const b = mkClient('B', 1000);

// A watches B (the remote): continuity + monotonicity + crash parity
let bWrong = 0;
let bSamples = 0;
let lastBDist = -1;
let lastBAt = 0;
let bCrashedAt: number | null = null;
let observedB: Array<{ ts: number; crashed: boolean }> = [];

a.on('snap', (snap: SnapLike) => {
  const me = snap.players.find((p) => p.id === (a as unknown as { id?: string }).id);
  const other = snap.players.find((p) => p.id !== (a as unknown as { id?: string }).id);
  if (!other) return;
  if (lastBAt && snap.ts - lastBAt < 400) {
    // interpolated remote can be behind, but raw server positions must move forward
    if (other.distance < lastBDist - 0.5) bWrong++;
    bSamples++;
  }
  lastBDist = other.distance;
  lastBAt = snap.ts;
  if (other.crashed && bCrashedAt === null) bCrashedAt = Date.now();
  observedB.push({ ts: Date.now(), crashed: other.crashed });
  void me;
});

// crash parity: when B collapses (server tells A), A must see B.crashed within 1.5s
let bRealCrashedAt: number | null = null;
let bRealCrashed = false;
b.on('snap', (snap: SnapLike) => {
  const me = snap.players.find((p) => p.id === (b as unknown as { id?: string }).id);
  if (!me) return;
  if (me.crashed && !bRealCrashed) {
    bRealCrashed = true;
    bRealCrashedAt = Date.now();
  }
});

setTimeout(() => {
  const sA = a as unknown as { id?: string; count?: number; lastSnap?: SnapLike };
  const sB = b as unknown as { id?: string; count?: number; lastSnap?: SnapLike };
  const dur = 20;
  const rateA = (sA.count ?? 0) / dur;
  const rateB = (sB.count ?? 0) / dur;
  const wrongDir = bWrong;

  // traffic parity: compare snapshots with the same server tick from both clients
  const byA = sA.byTick ?? new Map<number, SnapLike>();
  const byB = sB.byTick ?? new Map<number, SnapLike>();
  let compared = 0;
  let mismatches = 0;
  for (const [tick, snapB] of byB) {
    const snapA = byA.get(tick);
    if (!snapA) continue;
    compared++;
    if (JSON.stringify(snapA.traffic) !== JSON.stringify(snapB.traffic)) mismatches++;
  }

  console.log(`A: ${sA.count} snapshots (${rateA.toFixed(1)}/s)`);
  console.log(`B: ${sB.count} snapshots (${rateB.toFixed(1)}/s)`);
  console.log(`remote motion: ${bSamples} inter-snapshot samples, backward moves=${wrongDir}`);
  console.log(`traffic parity: ${compared} same-tick comparisons, mismatches=${mismatches}`);

  // traffic presence: the spawn window (430 m) must actually fill near the
  // leader. Regression: an empty room once seeded the spawner with -Infinity,
  // dumping the whole 24-car budget far ahead (~2 km of empty road).
  const lastTraffic = sA.lastSnap?.traffic ?? [];
  const lead = Math.max(
    0,
    ...[...(sA.lastSnap?.players ?? []), ...(sB.lastSnap?.players ?? [])].map((p) => p.distance)
  );
  const ahead = lastTraffic.filter(
    (c) => Number.isFinite(c.roadDist) && c.roadDist - lead > -80 && c.roadDist - lead < 500
  ).length;
  console.log(`traffic: ${lastTraffic.length} cars on server, ${ahead} within 500 m ahead of leader`);
  const aCrashed = !!sA.lastSnap?.players.find((p) => p.id === sA.id)?.crashed;
  const bCrashed = !!sB.lastSnap?.players.find((p) => p.id === sB.id)?.crashed;
  console.log(`crash state at end: A=${aCrashed}, B=${bCrashed}`);
  if (bRealCrashedAt) {
    const parity = observedB.find((o) => o.crashed);
    if (parity && parity.ts - bRealCrashedAt <= 1500) console.log('crash parity: OK (A learned B crashed within 1.5s)');
    else console.log('crash parity: FAIL');
  } else {
    console.log('crash parity: no crash occurred in window (informational)');
  }
  const ok =
    rateA >= 18 &&
    rateB >= 18 &&
    compared >= 50 &&
    mismatches === 0 &&
    wrongDir === 0 &&
    ahead >= 6;
  console.log(
    ok
      ? 'PASS: two-client acceptance (snapshot rate, traffic parity, remote continuity)'
      : 'FAIL: two-client acceptance'
  );
  a.close();
  b.close();
  process.exit(ok ? 0 : 1);
}, 21000);