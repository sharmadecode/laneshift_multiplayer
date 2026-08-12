# Highway Rush — Network Protocol (Phase 2)

Authoritative server: **clients send only control inputs**; the server owns physics, traffic, and collisions, and broadcasts state snapshots.

## Transport
- Socket.IO, `websocket` transport only.
- Server: `apps/game-server` (port 5200 in dev, `PORT` env otherwise).
- Client resolves the URL: `VITE_SERVER_URL` env override → `http://localhost:5200` on localhost → same origin otherwise.

## Events

### Client → Server
| Event | Payload | Notes |
|---|---|---|
| `in` | `{ seq: number, steering: -1\|0\|1, throttle: 0..1, brake: 0..1 }` | Rate-limited to 60/s per socket; ranges validated and clamped server-side. `seq` is used for prediction reconciliation (`lastSeq` is echoed back). |

### Server → Client
| Event | Payload | Notes |
|---|---|---|
| `welcome` | `{ playerId, roomId, players: PlayerSnapshot[] }` | Sent once on connect. |
| `snap` | `WorldSnapshot { tick, ts, players: PlayerSnapshot[], traffic: TrafficCar[] }` | 20 Hz. Full traffic list — every player sees the identical world. |
| `pj` | `PlayerSnapshot` | Another player joined. |
| `pl` | `{ playerId }` | A player left/disconnected. |
| `crash` | `{ playerId, x }` | Server-confirmed crash; all clients play FX at `x`. |

### Snapshot shapes
```ts
PlayerSnapshot {
  id: string; name: string;
  x: number; speed: number; distance: number; steering: number;
  crashed: boolean; crashTimer: number; ghost: boolean;
  lastSeq: number;           // last applied input seq (reconciliation)
}
TrafficCar { id, lane, x, roadDist, speed, length, width, modelIndex, colorIndex }
```

## Client behaviour (prediction + interpolation)
1. **Local player**: `stepPlayer` runs immediately on each input (predictive). Inputs are buffered with their seq and frame dt.
2. On each snapshot, the client takes the server state for itself, drops buffered inputs with `seq <= lastSeq`, replays the rest, and adopts the result — so steering stays responsive and corrections snap in exactly when the server disagrees.
3. **Server crash wins**: if the snapshot says crashed while the client predicted a near-miss, the client corrects; if the client predicted a crash the server didn't confirm, it is reverted.
4. **Remote players**: rendered ~100 ms in the past, linearly interpolated between consecutive snapshots.
5. **Traffic**: rendered only from server snapshots (never simulated client-side online).

## Server simulation (authoritative)
- Fixed 30 Hz tick: `stepPlayer` per player, shared `TrafficSpawner` (multi-player aware: spawns ahead of the leader, despawns only behind the slowest), per-player capsule collisions vs traffic (`playerHitsTraffic`).
- Deterministic per room (seeded spawner) — all clients see the same cars with the same IDs.
- One shared room in Phase 2 (`rush`); rooms/codes/lobby/countdown arrive in Phase 3.
