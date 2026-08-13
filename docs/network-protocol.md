# Highway Rush — Network Protocol (Phase 2)

Authoritative server: **clients send only control inputs**; the server owns physics, traffic, and collisions, and broadcasts state snapshots.

## Transport
- Socket.IO, `websocket` transport only.
- Server: `apps/game-server` (port 5200 in dev, `PORT` env otherwise).
- Client resolves the URL: `VITE_SERVER_URL` env override → `http://localhost:5200` on localhost → `http://<hostname>:5200` for any other host (phone via LAN IP).

## Events

### Client → Server
| Event | Payload | Notes |
|---|---|---|
| `in` | `{ seq: number, steering: -1\|0\|1, throttle: 0..1, brake: 0..1 }` | Throttled to 30/s by the client; rate-limited to 60/s and range-validated server-side. `seq` is echoed back as `appliedSeq`. |

### Server → Client
| Event | Payload | Notes |
|---|---|---|
| `welcome` | `{ playerId, roomId, players: PlayerSnapshot[] }` | Sent once on connect. |
| `snap` | `WorldSnapshot { tick, ts, players: PlayerSnapshot[], traffic: TrafficCar[] }` | 20 Hz average (alternates 1/2-tick gaps from the 30 Hz sim). `ts` is `Date.now()` on the server — the client uses it as the shared clock base. |
| `pj` | `PlayerSnapshot` | Another player joined. |
| `pl` | `{ playerId }` | A player left/disconnected. |
| `crash` | `{ playerId, x }` | Server-confirmed crash; all clients play FX at `x`. |

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
- **Late joiners** spawn 100 m behind the trailing racer with ghost protection (`GHOST_TIME`); the world resets when the room empties.
- Snapshot emission uses a remainder-preserving accumulator (`snapTimer -= interval`, not `= 0`): resets to zero from a 30 Hz sim produce 15 Hz, not 20 Hz.
- Deterministic per room (seeded spawner) — all clients see the same cars with the same IDs.
- One shared room in Phase 2 (`rush`); rooms/codes/lobby/countdown arrive in Phase 3.

## Verification
- `apps/game-server/mp-check.ts` — single-client prediction harness (mirrors Game.ts verbatim). Expected: `safety-net corrections: 0`, `offset x/distance: 0.000`, frame deltas ≤ one frame of top-speed motion (gaps from crash/ghost transitions are not measured as jumps).
- `apps/game-server/verify-mp.ts` — two-client acceptance: ≥ 18 snapshots/s each, byte-identical traffic at equal ticks, monotonic remote motion, traffic present within 500 m of the leader. Gaps between server ticks show as 1/2 alternating.
- `apps/game-server/verify-packs.ts` — parked-racer scenario (A drives, B parks 12 s, B resumes): no starvation for A while B parks, B gets a seeded pack within 2 s of moving, no same-lane overlaps, car count ≤ 60, no non-finite positions, byte-identical traffic at equal ticks.