# Highway Rush — Network Protocol (Phase 3)

Authoritative server: **clients send only control inputs**; the server owns physics, traffic, collisions, and the match lifecycle, and broadcasts state snapshots.

## Transport
- Socket.IO, `websocket` transport only.
- Server: `apps/game-server` (port 5200 in dev, `PORT` env otherwise).
- Client resolves the URL: `VITE_SERVER_URL` env override → `http://localhost:5200` on localhost → `http://<hostname>:5200` for any other host (phone via LAN IP).

## Connection flow (rooms)
1. Connect → server emits `welcome { playerId }` (identity for this session's socket). No room yet.
2. Client sends `createRoom { name }`, `joinRoom { code, name }`, or `quickJoin { name }` (or `rejoinRoom { roomId, token }`); the server answers with an **ack**: `{ ok: true, playerId, token, roomId }` or `{ ok: false, error }`.
3. Room membership is broadcast to everyone in the room as `roomState`.
4. Rooms are destroyed when empty. Joins are allowed in any phase (≤ 6 players); mid-race joins spawn at the back of the field.

## Events

### Client → Server
| Event | Payload | Notes |
|---|---|---|
| `in` | `{ seq, steering: -1\|0\|1, throttle: 0..1, brake: 0..1 }` | Throttled to 30/s by the client; rate-limited to 60/s and range-validated server-side. `seq` is echoed back as `appliedSeq`. |
| `createRoom` | `{ name }` | Validated (1–16 chars, control chars stripped). Ack. Rate-limited 5/min/socket. |
| `joinRoom` | `{ code, name }` | Code regex `^[A-Z2-9]{5}$`. Ack with errors: `room not found` / `room full`. Joins allowed in every phase; in `racing`/`finished` the new player spawns at the back of the field, ghosted. Reserved seats (dropout grace) are evicted oldest-first when a newcomer needs the last slot. Rate-limited 5/min/socket. |
| `quickJoin` | `{ name }` | Auto-fills an open session: **racing** rooms first (spawn at the back), then **countdown** (line), then the fullest **lobby** room, then **finished** rooms (result hold — the lobby + a rematch follow within seconds). Reserved seats don't block newcomers. None open → creates a fresh room (defaults `endless`, density 1.0) with the joiner as host. Cap 6. Ack as `joinRoom`. Rate-limited 5/min/socket. |
| `rejoinRoom` | `{ roomId, token }` | Reclaims a seat reserved on mid-race disconnect (45 s). Ack; same `playerId` is returned so prediction keeps its identity. Rate-limited 10/min/socket. |
| `startMatch` | `{ settings: { mode, density } }` | Host + lobby phase only. `mode` ∈ `endless \| 1 \| 40 \| 60 \| 100` (km; `1` is harness-only), density clamped 0.55–1.3. |
| `rematch` | `{}` | Host + finished phase only → back to lobby, same players/settings. |
| `leaveRoom` | `{}` | Permanent removal (also revokes the rejoin token). |

### Server → Client
| Event | Payload | Notes |
|---|---|---|
| `welcome` | `{ playerId }` | Sent once per connection. The **join token** (from the acks) is what survives page reloads for reconnect. |
| `roomState` | `{ roomId, code, hostId, phase, settings, countdownT, players: LobbyPlayer[], finished: string[] }` | Broadcast on every room change (join, leave, phase, host change). `players` are `{ id, name, isHost }`. |
| `countdown` | `{ t }` | 4,3,2,1 (the 5 is the initial `roomState`). |
| `matchStart` | `{}` | All racers reset to the line, fresh deterministic traffic world. |
| `snap` | `WorldSnapshot { tick, ts, players: PlayerSnapshot[], traffic: TrafficCar[] }` | 20 Hz average (alternates 1/2-tick gaps from the 30 Hz sim) while `racing`/`finished`. `ts` is `Date.now()` on the server — the client uses it as the shared clock base. |
| `finish` | `{ playerId, rank, timeMs }` | Crossed the line (non-endless modes). |
| `matchResult` | `{ rankings: [{ playerId, name, rank, distance, timeMs }], mode }` | When everyone has finished; replayed to a rejoining player who missed it. Room auto-returns to lobby after 8 s. |
| `crash` | `{ playerId, x }` | Server-confirmed crash; all clients play FX at `x`. |
| `hostChanged` | `{ hostId }` | Host left; always followed by `roomState`. |
| `pl` | `{ playerId }` | A player left/disconnected permanently. |

### Snapshot shapes
```ts
PlayerSnapshot {
  id: string; name: string;
  x: number; speed: number; distance: number; steering: number;
  crashed: boolean; crashTimer: number; ghost: boolean;
  appliedSeq: number;        // latest input seq the sim has stepped (reconciliation)
}
TrafficCar { id, lane, x, roadDist, speed, length, width, modelIndex, colorIndex }
```

## Match lifecycle (server)
`lobby → countdown(5 s) → racing → finished → lobby (rematch or 8 s hold)`

- **lobby**: joins allowed (≤ 6). Host edits settings and starts; host leaving promotes the oldest remaining player.
- **countdown**: joins allowed (the new player starts at the line with everyone else — `matchStart` resets all cars); inputs ignored until racing.
- **racing**: as Phase 2 (below). Finish when `distance ≥ mode km`; rank = crossing order; all-finished ends the match. **Mid-race join**: the new player spawns at the position of the last racer still crossing, with that racer's speed, `ghost`ed for `GHOST_TIME` so traffic at the spawn point can't insta-crash them. Reserved seats (dropout grace) are evicted oldest-first if a newcomer needs the last slot — the evicted player's token expires (`rejoin expired`).
- **finished**: joins allowed (spawn at 0 m; the result is replayed to them, and the room returns to lobby within 8 s). A reserved seat that doesn't rejoin is dropped when the lobby reopens — no phantoms.
- **disconnect during racing**: the car coasts to a stop, the seat is **reserved 45 s**; `rejoinRoom` with the stored token rebinds the socket to the same `playerId` (snapshots resume). Lobby/countdown drops are permanent.

## Client behaviour (prediction + interpolation)
1. **Local player — grid prediction**: the client steps `stepPlayer` only on the server's 30 Hz tick grid (accumulator anchored to snapshot arrivals), applying the **last input actually sent** (`seq`) each step. The server applies the latest-received input per tick, so the two trajectories are **identical**, offset only by network latency. Sends are phase-locked to arrival (`Net.resync`) so each input lands in its own tick window (~1 input/tick, no server-side collapse).
2. **Reconciliation** (only on real divergence: `|x| > 1.25 m` or `|speed| > 5 m/s` or `|distance| > 7 m`): restore the server state, replay buffered inputs with `seq > appliedSeq`, and ease the resulting visual jump via a decaying `visualCorrection` so the road never snaps.
3. **Crash/ghost are authoritative**: applied immediately from the snapshot. Crashes are server-confirmed only (no local online collision check), so the crash FX always fires at a position you can actually see.
4. **Remote players**: server time is reconstructed from `ts` via a smoothed clock-offset estimate; rendered ~100 ms in the past, linearly interpolated between consecutive snapshots.
5. **Traffic**: served only from snapshots (never simulated client-side online), interpolated on the same server-clock axis so it never slides backwards between arrivals. Rendered in the local car's frame (delay 0, extrapolated past the newest snapshot by car speed) so collisions and visuals coincide.

## Server simulation (authoritative)
- **30 Hz fixed-step loop driven by a wall-clock accumulator** (5 ms poll). Bare `setInterval(33.3ms)` must not be used: on Windows, 16 ms OS timer granularity clamps it to ~47 ms → ~21 Hz world.
- `stepPlayer` per player, shared `TrafficSpawner`, per-player capsule collisions vs traffic (`playerHitsTraffic`).
- **Multi-anchor traffic**: `lead`/`trail` are computed from *active* racers only (a player parked > 4 s no longer pins the world). The leader's window refills as normal; any active racer stranded > 530 m behind the traffic front gets a personal pack seeded every 8 s (late joiners, parked-then-go racers, slow starters). Seeds only fill lanes free of cars in the local window, so packs merge with zero overlap. Cap scales with active racers (24 + 12 each, hard cap 60). Cars beyond `lead + 730` are culled (departed-player debris).
- Snapshot emission uses a remainder-preserving accumulator (`snapTimer -= interval`, not `= 0`): resets to zero from a 30 Hz sim produce 15 Hz, not 20 Hz.
- Deterministic per room (seeded spawner) — all clients see the same cars with the same IDs.
- Rooms are keyed by their 5-char code; `playerId` is stable across socket reconnects (socket→player map, io rooms for broadcast).

## Verification
- `apps/game-server/room-flow.ts` — shared harness plumbing (connect → create/join → start → wait matchStart).
- `apps/game-server/verify-rooms.ts` — Phase 3 acceptance: 5-char codes, 6-player cap, bogus-code rejection, non-host `startMatch` ignored, countdown 4..1 + `matchStart`, all players finish with unique ranks and ordered `matchResult`, rematch → lobby, host promotion on leave, mid-race disconnect reservation + token rejoin preserving `playerId`, forged-token rejection, reserved seats don't stall the result or leak into the reopened lobby, stale tokens from a completed match are rejected, quick join (fills a racing room with a back-of-field ghosted spawn, honors the cap, creates a fresh endless room when nothing is open).
- `apps/game-server/mp-check.ts` — single-client prediction harness (mirrors Game.ts verbatim). Expected: `safety-net corrections: 0`, `offset x/distance: 0.000`, frame deltas ≤ one frame of top-speed motion (gaps from crash/ghost transitions are not measured as jumps).
- `apps/game-server/verify-mp.ts` — two-client acceptance: ≥ 18 snapshots/s each, byte-identical traffic at equal ticks, monotonic remote motion, traffic present within 500 m of the leader. Gaps between server ticks show as 1/2 alternating.
- `apps/game-server/verify-packs.ts` — parked-racer scenario (A drives, B parks 12 s, B resumes): no starvation for A while B parks, B gets a seeded pack within 2 s of moving, no same-lane overlaps, car count ≤ 60, no non-finite positions, byte-identical traffic at equal ticks.
