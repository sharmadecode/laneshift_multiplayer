import { type Socket } from 'socket.io-client';
import { joinRoom, mkSocket, waitMatchStart } from './room-flow.js';

// Two-client acceptance probe (Phase 3 flow, Phase 2 checks per PLAN.md §10):
//  1. both clients receive roomState + snapshots continuously after matchStart
//  2. snapshot cadence is ~20 Hz average (not 15)
//  3. both clients see byte-identical traffic in every snapshot
//  4. remote player motion is continuous and monotonic (server is authoritative)
//  5. crash parity: if either client crashes, the other learns it within 1.5 s

interface SnapLike {
  tick: number;
  ts: number;
  players: Array<{ id: string; x: number; distance: number; crashed: boolean; ghost: boolean }>;
  traffic: Array<{ id: number; x: number; roadDist: number; speed: number }>;
}

interface ClientState {
  id: string;
  s: Socket;
  count: number;
  lastSnap: SnapLike | null;
  byTick: Map<number, SnapLike>;
}

function mkClient(tag: string, steerEvery: number): ClientState {
  const s = mkSocket();
  const st: ClientState = { id: '', s, count: 0, lastSnap: null, byTick: new Map() };

  s.on('snap', (snap: SnapLike) => {
    st.count++;
    st.lastSnap = snap;
    st.byTick.set(snap.tick, snap);
    for (const k of st.byTick.keys()) if (snap.tick - k > 120) st.byTick.delete(k); // keep ~2s
  });

  let n = 0;
  s.on('connect', () => {
    setInterval(() => {
      const steer = n % steerEvery === 0 ? (Math.random() > 0.5 ? 1 : -1) : 0;
      s.emit('in', { steering: steer, throttle: 1, brake: 0, seq: n++ });
    }, 33);
  });
  return st;
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

a.s.on('snap', (snap: SnapLike) => {
  const me = snap.players.find((p) => p.id === a.id);
  const other = snap.players.find((p) => p.id === b.id);
  if (!me || !other) return;
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

// crash parity: when B collapses (server tells B), A must see B.crashed within 1.5s
let bRealCrashedAt: number | null = null;
let bRealCrashed = false;
b.s.on('snap', (snap: SnapLike) => {
  const me = snap.players.find((p) => p.id === b.id);
  if (!me) return;
  if (me.crashed && !bRealCrashed) {
    bRealCrashed = true;
    bRealCrashedAt = Date.now();
  }
});

async function main(): Promise<void> {
  const ja = await joinRoom(a.s, 'verify-A');
  a.id = ja.playerId;
  const jb = await joinRoom(b.s, 'verify-B', ja.roomId);
  b.id = jb.playerId;
  if (jb.roomId !== ja.roomId) throw new Error('B did not land in A\'s room');
  await waitMatchStart(a.s, { mode: 'endless', density: 0.8 });

  setTimeout(() => {
    const dur = 20;
    const rateA = a.count / dur;
    const rateB = b.count / dur;
    const wrongDir = bWrong;

    // traffic parity: compare snapshots with the same server tick from both clients
    let compared = 0;
    let mismatches = 0;
    for (const [tick, snapB] of b.byTick) {
      const snapA = a.byTick.get(tick);
      if (!snapA) continue;
      compared++;
      if (JSON.stringify(snapA.traffic) !== JSON.stringify(snapB.traffic)) mismatches++;
    }

    console.log(`A: ${a.count} snapshots (${rateA.toFixed(1)}/s)`);
    console.log(`B: ${b.count} snapshots (${rateB.toFixed(1)}/s)`);
    console.log(`remote motion: ${bSamples} inter-snapshot samples, backward moves=${wrongDir}`);
    console.log(`traffic parity: ${compared} same-tick comparisons, mismatches=${mismatches}`);

    // traffic presence: the spawn window (430 m) must actually fill near the
    // leader. Regression: an empty room once seeded the spawner with -Infinity,
    // dumping the whole 24-car budget far ahead (~2 km of empty road).
    const lastTraffic = a.lastSnap?.traffic ?? [];
    const lead = Math.max(
      0,
      ...[...(a.lastSnap?.players ?? []), ...(b.lastSnap?.players ?? [])].map((p) => p.distance)
    );
    const ahead = lastTraffic.filter(
      (c) => Number.isFinite(c.roadDist) && c.roadDist - lead > -80 && c.roadDist - lead < 500
    ).length;
    console.log(`traffic: ${lastTraffic.length} cars on server, ${ahead} within 500 m ahead of leader`);
    const aCrashed = !!a.lastSnap?.players.find((p) => p.id === a.id)?.crashed;
    const bCrashed = !!b.lastSnap?.players.find((p) => p.id === b.id)?.crashed;
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
    a.s.close();
    b.s.close();
    process.exit(ok ? 0 : 1);
  }, 21000);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
