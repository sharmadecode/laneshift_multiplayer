import { type Socket } from 'socket.io-client';
import { NET_EVENTS, type CountdownMsg, type FinishMsg, type MatchResultMsg, type RoomStateMsg } from '@hr/shared';
import { joinRoom, mkSocket, quickJoin, waitMatchStart } from './room-flow.js';

// Phase 3 private-rooms acceptance:
//  1. create room -> 5-char code; 6 players join; 7th rejected (full)
//  2. joining a bogus code -> rejected
//  3. non-host startMatch is ignored
//  4. host startMatch -> countdown 5..1 -> matchStart -> everyone races
//  5. 1 km test mode: all 6 finish, ranks 1..6 unique, matchResult rankings correct
//  6. host rematch -> lobby; host leaves -> host promotes to the next player
//  6b. an AFK racer (parked past the idle grace) forfeits as DNF instead of
//      blocking the match result forever
//  7. mid-race disconnect reserves the seat; the player rejoins with the token
//     and keeps their playerId; a forged token is rejected
//  8. a reserved seat does not block the match end (result has 5 ranks) and the
//     disconnected player is dropped when the lobby reopens (no phantom)
//  9. stale token from a completed match cannot rejoin the next one
// 10. quick join: fills a racing room (spawn at the back, ghosted), honors the
//     6-player cap, creates a fresh endless room when nothing is open, and
//     lands in a finished room's result hold (spawn at 0 + result replay)

interface Joined {
  id: string;
  token: string;
  code: string;
  s: Socket;
  finishes: FinishMsg[];
  states: RoomStateMsg[];
}

const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

function driver(s: Socket): void {
  let n = 0;
  setInterval(() => {
    const d = s as Socket & { driving?: boolean };
    if (!s.connected || d.driving === false) return;
    s.emit('in', { steering: n % 5 === 0 ? (Math.random() > 0.5 ? 1 : -1) : 0, throttle: 1, brake: 0, seq: n++ });
  }, 33);
}

function mkJoined(name: string): Joined {
  const s = mkSocket();
  const j: Joined = { id: '', token: '', code: '', s, finishes: [], states: [] };
  s.on(NET_EVENTS.finish, (m: FinishMsg) => j.finishes.push(m));
  s.on(NET_EVENTS.roomState, (st: RoomStateMsg) => j.states.push(st));
  driver(s);
  return j;
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

/** Poll until the newest roomState on the client satisfies the predicate. */
async function waitState(j: Joined, pred: (s: RoomStateMsg) => boolean, what: string, timeoutMs = 8000): Promise<RoomStateMsg> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const last = j.states[j.states.length - 1];
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Emit rejoinRoom once the socket is welcomed; resolves the ack result. */
async function doRejoin(s: Socket, roomId: string, token: string, code: string): Promise<{ ok: boolean; error?: string; playerId?: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('rejoin ack timeout')), 5000);
    const attempt = (): void => {
      s.emit(NET_EVENTS.rejoinRoom, { roomId, token }, (r: { ok: boolean; error?: string; playerId?: string }) => {
        clearTimeout(t);
        resolve(r);
      });
    };
    if ((s as unknown as { __welcomed?: boolean }).__welcomed) attempt();
    else s.once(NET_EVENTS.welcome, attempt);
  });
}

async function main(): Promise<void> {
  const clients: Joined[] = [];

  // 1. create + join up to 6
  const a = mkJoined(names[0]);
  clients.push(a);
  const ja = await joinRoom(a.s, 'A');
  a.id = ja.playerId;
  a.token = ja.token;
  a.code = ja.roomId;
  if (!/^[A-Z2-9]{5}$/.test(a.code)) fail(`room code ${a.code} invalid`);
  console.log(`created room ${a.code}`);

  for (let i = 1; i < 6; i++) {
    const c = mkJoined(names[i]);
    const j = await joinRoom(c.s, names[i], a.code);
    c.id = j.playerId;
    c.token = j.token;
    c.code = j.roomId;
    clients.push(c);
    console.log(`joined ${names[i]} as ${c.id.slice(0, 6)}`);
  }
  await new Promise((r) => setTimeout(r, 300)); // let the last roomState broadcast land
  const lobbyState = a.states[a.states.length - 1];
  if (!lobbyState || lobbyState.players.length !== 6) fail(`lobby has ${lobbyState?.players.length} players, want 6`);
  console.log('create + 6 joins: OK');

  // 2. full room + bad code
  const g = mkJoined(names[6]);
  const jg = await joinRoom(g.s, 'G', a.code).then(
    () => ({ ok: true }),
    (e: Error) => ({ ok: false, error: e.message })
  );
  if (jg.ok) fail('7th player joined a full room');
  g.s.close();

  const bad = mkJoined('bad');
  const jbad = await joinRoom(bad.s, 'bad', 'ZZZZZ').then(
    () => ({ ok: true }),
    (e: Error) => ({ ok: false, error: e.message })
  );
  if (jbad.ok) fail('bogus code accepted');
  bad.s.close();
  console.log('full-room + bad-code rejection: OK');

  // 3. non-host startMatch ignored
  const b = clients[1];
  b.s.emit(NET_EVENTS.startMatch, { settings: { mode: 1, density: 0.8 } });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      b.s.off(NET_EVENTS.countdown);
      resolve();
    }, 1000);
    b.s.once(NET_EVENTS.countdown, () => {
      clearTimeout(t);
      reject(new Error('non-host started a countdown'));
    });
  });
  console.log('non-host startMatch ignored: OK');

  // 4. host start -> countdown -> matchStart
  const countdowns: CountdownMsg[] = [];
  a.s.on(NET_EVENTS.countdown, (m: CountdownMsg) => countdowns.push(m));
  await waitMatchStart(a.s, { mode: 1, density: 0.8 });
  if (countdowns.map((c) => c.t).join(',') !== '4,3,2,1') fail(`countdown sequence ${JSON.stringify(countdowns)}`);
  console.log('countdown 4,3,2,1 + matchStart: OK');

  // 5. all six finish; rankings complete and ordered
  const result: MatchResultMsg = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('matchResult timeout')), 60000);
    a.s.once(NET_EVENTS.matchResult, (m: MatchResultMsg) => {
      clearTimeout(t);
      resolve(m);
    });
  });
  const finishedRanks = new Set<number>();
  for (const c of clients) {
    if (c.finishes.length === 0) fail(`${c.id} never finished`);
    for (const f of c.finishes) finishedRanks.add(f.rank);
  }
  for (let r = 1; r <= 6; r++) {
    if (!finishedRanks.has(r)) fail(`rank ${r} missing`);
  }
  if (result.rankings.length !== 6) fail(`result has ${result.rankings.length} entries`);
  for (let i = 0; i < result.rankings.length; i++) {
    const r = result.rankings[i];
    if (r.rank !== i + 1) fail(`result rank order broken at ${i}`);
    if (i > 0 && r.timeMs < result.rankings[i - 1].timeMs) fail('finish times not monotonic');
  }
  const myRank = result.rankings.find((r) => r.playerId === a.id)?.rank ?? -1;
  console.log(`all 6 finished, rankings complete (A finished #${myRank}): OK`);

  // 6. rematch -> lobby; host leaves -> promote
  const beforeRematch = await waitState(a, (s) => s.phase === 'finished', 'finished phase', 10000);
  a.s.emit(NET_EVENTS.rematch);
  const lobbyAfter = await waitState(a, (s) => s.phase === 'lobby', 'lobby after rematch');
  if (lobbyAfter.players.length !== 6) fail('rematch lost players');
  a.s.emit(NET_EVENTS.leaveRoom);
  const promoted = await waitState(b, (s) => s.hostId === b.id && s.players.length === 5, 'host promotion');
  if (promoted.players.length !== 5) fail(`lobby should have 5 after A left`);
  console.log('rematch + host promotion: OK');

  // 6b. an AFK racer (parked past the idle grace) forfeits as DNF instead of
  //     blocking the result forever: {B,C,D,E,F} race; C parks at the line.
  const c = clients[2];
  const cFinishCountBefore = c.finishes.length;
  await waitMatchStart(b.s, { mode: 1, density: 0.8 });
  (c.s as unknown as { driving: boolean }).driving = false;
  await new Promise((r) => setTimeout(r, 200)); // let the input rate-limit window clear
  c.s.emit('in', { steering: 0, throttle: 0, brake: 1, seq: 1e9 }); // brake once, then silence
  const dnfResult = await new Promise<MatchResultMsg>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('DNF match result timeout')), 60000);
    b.s.once(NET_EVENTS.matchResult, (m: MatchResultMsg) => {
      clearTimeout(t);
      resolve(m);
    });
  });
  (c.s as unknown as { driving: boolean }).driving = true;
  if (dnfResult.rankings.length !== 5) fail(`DNF match ended with ${dnfResult.rankings.length} rankings`);
  const dnfEntry = dnfResult.rankings.find((r) => r.playerId === c.id);
  if (!dnfEntry || dnfEntry.timeMs !== -1) fail(`idle racer did not get a DNF entry: ${JSON.stringify(dnfEntry)}`);
  if (dnfEntry.rank !== 5) fail(`DNF rank is ${dnfEntry.rank}, want 5 (after the 4 finishers)`);
  if (c.finishes.slice(cFinishCountBefore).some((f) => f.playerId === c.id)) fail('the idle racer crossed the line');
  for (const r of dnfResult.rankings.slice(0, 4)) {
    if (r.timeMs < 0) fail('a finisher was marked DNF');
  }
  console.log('AFK racer forfeits as DNF, result not blocked: OK');
  await waitState(b, (s) => s.phase === 'lobby', 'lobby after the DNF match', 15000);

  // 7. mid-race disconnect -> reserved -> token rejoin keeps playerId
  await waitMatchStart(b.s, { mode: 1, density: 0.8 });
  const cOriginalId = c.id;
  await new Promise((r) => setTimeout(r, 3000)); // let the race run a little
  c.s.close(); // disconnect mid-race -> reservation
  await new Promise((r) => setTimeout(r, 500));

  const rs = mkSocket();
  let rejoinState: RoomStateMsg | null = null;
  rs.on(NET_EVENTS.roomState, (st: RoomStateMsg) => {
    rejoinState = st;
  });
  const rj = await doRejoin(rs, c.code, c.token, c.code);
  if (!rj.ok) fail(`rejoin rejected: ${rj.error}`);
  if (rj.playerId !== cOriginalId) fail(`rejoin changed playerId ${cOriginalId} -> ${rj.playerId}`);
  const t0 = Date.now();
  while (!rejoinState && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
  if (!rejoinState) fail('rejoin roomState timeout');
  if (!rejoinState.players.some((p) => p.id === cOriginalId)) fail('rejoined player missing from room');
  driver(rs);
  rs.close(); // drop again: C's seat stays reserved through this match's tail
  console.log('mid-race reservation + token rejoin (id preserved): OK');

  // forged token rejected
  const fake = mkSocket();
  const forged = await doRejoin(fake, c.code, 'deadbeefdeadbeef', c.code);
  fake.close();
  if (forged.ok) fail('forged token was accepted');
  console.log('forged-token rejection: OK');

  // 8. reserved seat neither blocks the match end nor leaks into the lobby.
  //    The room holds {B,C,D,E,F} (A left in step 6). C dropped twice and never
  //    came back: the result must not wait 45 s for a seat that cannot finish.
  const resNoDrop = await new Promise<MatchResultMsg>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('match 3 result timeout')), 60000);
    b.s.once(NET_EVENTS.matchResult, (m: MatchResultMsg) => {
      clearTimeout(t);
      resolve(m);
    });
  });
  const expectedIds = new Set([clients[1].id, clients[3].id, clients[4].id, clients[5].id]);
  if (resNoDrop.rankings.length !== 4) fail(`match with a drop ended with ${resNoDrop.rankings.length} rankings`);
  for (const r of resNoDrop.rankings) {
    if (!expectedIds.has(r.playerId)) fail(`unexpected finisher ${r.playerId}`);
    expectedIds.delete(r.playerId);
  }
  if (expectedIds.size !== 0) fail('a non-dropped player missed the result');
  console.log('reserved seat did not stall the result (4 ranks): OK');

  // The lobby reopens with 4: the reserved player was dropped, not haunted.
  const lobby5 = await waitState(b, (s) => s.phase === 'lobby' && s.players.length === 4, 'lobby with 4 after reserved drop', 15000);
  if (lobby5.players.some((p) => p.id === cOriginalId)) fail('reserved player leaked into the reopened lobby');
  console.log('reserved seat dropped on lobby reopen (no phantom): OK');

  // 9. stale token from a completed match is rejected mid-race
  await waitMatchStart(b.s, { mode: 1, density: 0.8 });
  const d = clients[3];
  const dOriginalId = d.id;
  await new Promise((r) => setTimeout(r, 3000));
  d.s.close();
  await new Promise((r) => setTimeout(r, 500));
  const stale = await doRejoin(mkSocket(), c.code, c.token, c.code);
  if (stale.ok) fail('stale token from a completed match was accepted');
  console.log('stale-token rejection: OK');
  const dRejoin = mkSocket();
  const dr = await doRejoin(dRejoin, d.code, d.token, d.code);
  if (!dr.ok || dr.playerId !== dOriginalId) fail(`live rejoin failed: ${dr.error}`);
  driver(dRejoin);
  console.log('live reservation rejoin in the next match: OK');

  // 10. quick join
  //   a) a racing room is open (match 4, {B,D,E,F}): the joiner lands there and
  //      spawns at the back of the field, ghosted, with the cap still enforced.
  const roomCode = b.code;
  const qj = mkSocket();
  const qjSnaps: Array<{ players: Array<{ id: string; distance: number; ghost: boolean }> }> = [];
  qj.on(NET_EVENTS.snapshot, (s: { players: Array<{ id: string; distance: number; ghost: boolean }> }) => qjSnaps.push(s));
  const qjJoin = await quickJoin(qj, 'Q');
  if (qjJoin.roomId !== roomCode) fail(`quick join landed in ${qjJoin.roomId}, want the open racing room ${roomCode}`);
  console.log('quick join into a racing room: OK');
  const ownSnap = (): { distance: number; ghost: boolean } | null => {
    for (let i = qjSnaps.length - 1; i >= 0; i--) {
      const me = qjSnaps[i].players.find((p) => p.id === qjJoin.playerId);
      if (me) return me;
    }
    return null;
  };
  const tSpawn = Date.now();
  let first: { distance: number; ghost: boolean } | null = null;
  while (!first && Date.now() - tSpawn < 4000) {
    first = ownSnap();
    if (!first) await new Promise((r) => setTimeout(r, 50));
  }
  if (!first) fail('quick joiner never appeared in a snapshot');
  const ghostSeen = qjSnaps.some((s) => s.players.some((p) => p.id === qjJoin.playerId && p.ghost));
  if (!ghostSeen) fail('quick joiner was not ghosted at spawn');
  const s0 = qjSnaps.find((s) => s.players.some((p) => p.id === qjJoin.playerId));
  const minOther = Math.min(...s0!.players.filter((p) => p.id !== qjJoin.playerId).map((p) => p.distance));
  if (Math.abs(s0!.players.find((p) => p.id === qjJoin.playerId)!.distance - minOther) > 40) {
    fail('quick joiner did not spawn at the back of the field');
  }
  await new Promise((r) => setTimeout(r, 4000));
  const afterGhost = ownSnap();
  if (!afterGhost || afterGhost.ghost) fail('spawn ghost never cleared');
  driver(qj); // qj must cross the line for match 4 to end (asserted in step d)
  console.log('spawn at the back + ghost lifecycle: OK');

  //   b) second quick join fills the same room up to the 6-player cap
  const qj2 = mkSocket();
  const qj2Join = await quickJoin(qj2, 'R');
  if (qj2Join.roomId !== roomCode) fail('second quick join left the open racing room');
  await new Promise((r) => setTimeout(r, 500));
  const lastSnap = qjSnaps[qjSnaps.length - 1];
  const racingRoomSize = lastSnap ? lastSnap.players.length : 0;
  if (racingRoomSize > 6) fail(`racing room exceeded the cap: ${racingRoomSize}`);
  console.log(`second quick join fills the room (${racingRoomSize}/6): OK`);

  //   c) room is now full: quick join creates a fresh endless room, host = joiner
  const qj3 = mkSocket();
  const qj3States: RoomStateMsg[] = [];
  qj3.on(NET_EVENTS.roomState, (st: RoomStateMsg) => qj3States.push(st));
  const qj3Join = await quickJoin(qj3, 'S');
  if (qj3Join.roomId === roomCode) fail('full racing room accepted a 7th quick joiner');
  const tRoom = Date.now();
  let qj3Lobby: RoomStateMsg | null = null;
  while (!qj3Lobby && Date.now() - tRoom < 4000) {
    qj3Lobby = qj3States.find((st) => st.phase === 'lobby') ?? null;
    if (!qj3Lobby) await new Promise((r) => setTimeout(r, 50));
  }
  if (!qj3Lobby) fail('quick-join room never opened');
  if (qj3Lobby.settings.mode !== 'endless') fail(`quick-join room default mode is ${qj3Lobby.settings.mode}, want endless`);
  if (qj3Lobby.players.length !== 1) fail(`fresh quick-join room has ${qj3Lobby.players.length} players`);
  if (qj3Lobby.hostId !== qj3Join.playerId) fail('quick-join room host is not the joiner');
  qj3.close(); // its room dies with it, so step d has only the main room to target
  console.log('full room -> fresh endless room created for the joiner: OK');

  //   d) a room in its 8 s result hold is still a quick-join target: the joiner
  //      spawns at 0 (the race is over), gets the result replayed, and lands in
  //      the lobby when it reopens — ready for the rematch with real players.
  qj2.close(); // 5/6
  const resHold = await new Promise<MatchResultMsg>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('match 4 result timeout')), 60000);
    b.s.once(NET_EVENTS.matchResult, (m: MatchResultMsg) => {
      clearTimeout(t);
      resolve(m);
    });
  });
  if (resHold.rankings.length !== 5) fail(`match 4 ended with ${resHold.rankings.length} rankings`);
  const qj4 = mkSocket();
  const qj4States: RoomStateMsg[] = [];
  qj4.on(NET_EVENTS.roomState, (st: RoomStateMsg) => qj4States.push(st));
  let qj4Result: MatchResultMsg | null = null;
  qj4.on(NET_EVENTS.matchResult, (m: MatchResultMsg) => (qj4Result = m));
  const qj4Snaps: Array<{ players: Array<{ id: string; distance: number }> }> = [];
  qj4.on(NET_EVENTS.snapshot, (s: { players: Array<{ id: string; distance: number }> }) => qj4Snaps.push(s));
  const qj4Join = await quickJoin(qj4, 'T');
  if (qj4Join.roomId !== roomCode) fail(`quick join during the hold landed in ${qj4Join.roomId}, want ${roomCode}`);
  const tHold = Date.now();
  while (!qj4Result && Date.now() - tHold < 5000) await new Promise((r) => setTimeout(r, 50));
  if (!qj4Result) fail('finished-room joiner never got the result replay');
  const tSnap = Date.now();
  let qj4Me: { distance: number } | null = null;
  while (!qj4Me && Date.now() - tSnap < 5000) {
    for (let i = qj4Snaps.length - 1; i >= 0; i--) {
      const me = qj4Snaps[i].players.find((p) => p.id === qj4Join.playerId);
      if (me) {
        qj4Me = me;
        break;
      }
    }
    if (!qj4Me) await new Promise((r) => setTimeout(r, 50));
  }
  if (!qj4Me) fail('finished-room joiner never appeared in a snapshot');
  if (qj4Me.distance > 5) fail(`finished-room joiner spawned at ${qj4Me.distance} m, want ~0`);
  const tLobby = Date.now();
  let holdLobby: RoomStateMsg | null = null;
  while (!holdLobby && Date.now() - tLobby < 15000) {
    holdLobby = qj4States.find((st) => st.phase === 'lobby' && st.players.length === 6) ?? null;
    if (!holdLobby) await new Promise((r) => setTimeout(r, 50));
  }
  if (!holdLobby) fail('lobby after the result hold never reached 6 players');
  if (holdLobby.players.some((p) => p.id === qj2Join.playerId)) fail('dropped quick joiner leaked into the reopened lobby');
  console.log('quick join into a finished room (spawn at 0 + result replay + lobby): OK');

  for (const cl of clients) cl.s.close();
  qj.close();
  qj4.close();
  console.log('PASS: private rooms (codes, cap, host flow, countdown, finish, rematch, reconnect, drop semantics, quick join)');
  process.exit(0);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
