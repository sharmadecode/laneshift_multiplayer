# Phase 3 — Private Multiplayer Rooms + Quick Join (implementation plan)

Status: **implemented and harness-verified** (verify-rooms PASS incl. quick join; mp-check / verify-mp / verify-packs still green). Awaiting manual LAN acceptance + commit.
Scope per `docs/PLAN.md` §5: display name, create/join rooms by 5-char code (max 6), **quick join (auto-fill an open session, mid-race spawn at the back)**, host picks mode + density, 5 s countdown, reconnect with token (45 s reserve), finish + leaderboard, rematch. No accounts, no matchmaking.

## 1. Game modes

| Mode | Length | Finish rule |
|---|---|---|
| `endless` | — | none; race runs until players leave/rematch |
| `40` / `60` / `100` (km) | fixed distance | finish when a player's own `distance ≥ target`; rank = crossing order; match ends when everyone has finished (long-idle racers forfeit as DNF) |
| `1` (1 km) | harness only, hidden from UI | same finish rule; lets `verify-rooms.ts` test the finish flow in ~30 s |

Mode is a **room setting** chosen by the host in the lobby (before start). Density likewise (0.55–1.3, default 0.8).

## 2. Server room lifecycle (state machine)

```
menu(no room) ──create/join──▶ lobby ──host START──▶ countdown(5s) ──▶ racing
  ▲                            │                        (inputs ignored)   │
  └───── room destroyed ───────┘                                            │
  lobby ◀── rematch (host) ◀── finished ◀── all players finished ──────────┘
```

- **lobby**: join/leave allowed; host can edit settings + start. Host leaves → oldest remaining player promoted (`hostChanged` broadcast). Room destroyed when empty (map entry removed).
- **countdown**: 5 s. Server broadcasts `countdown { t }` each second (4…1; the 5 is the initial `roomState`), then `matchStart`. All player states reset to `distance=0, speed=0, x=0, ghost=false, crashed=false`; `spawner.reset(density)` → fresh deterministic world seeded at distance 0 (first cars 107–430 m ahead). Inputs are not applied during lobby/countdown.
- **racing**: existing 30 Hz sim, 20 Hz snapshots, packs, collisions — unchanged. On `distance ≥ target` (non-endless): mark `finished`, assign rank in crossing order, broadcast `finish { playerId, rank, timeMs }`. Finished players keep driving (rank locked). When all remaining players finished → `finished` phase, broadcast `matchResult { rankings }`, auto-return to `lobby` after 8 s unless a rematch already moved it.
- **rematch**: host-only, from `finished`; clears finish state, back to `lobby` with the same settings + players.

## 3. Protocol additions (`packages/shared/src/protocol.ts`)

Implemented as documented in `docs/network-protocol.md` §"Connection flow" + events table. Differences from the original sketch:

- **Acks instead of a `roomError` event**: `createRoom` / `joinRoom` / `rejoinRoom` return `{ ok, error?, token, roomId, playerId }` directly as socket.io acks. Errors: `room not found` / `room full` / `rejoin expired`.
- **`quickJoin { name }`**: auto-fills an open session — racing rooms first (spawn at the back, ghosted `GHOST_TIME`), then countdown (line), then the fullest lobby room; `finished` rooms skipped. None open → fresh room (defaults `endless`, density 1.0), joiner is host. Same ack shape, same 5/min rate limit, cap 6 enforced on every path.
- **Mid-race joins** (quick join or code join into `racing`/`finished`): spawn at the last racer still crossing, with that racer's speed; ghosted until `GHOST_TIME` elapses so traffic at the spawn point can't insta-crash them. From then on they are a normal member: must finish, reserved on disconnect, ranked at the end.
- `countdown` events are 4…1 (the initial 5 rides on `roomState.countdownT`).
- The client persists `{ roomId, token }` in localStorage and auto-rejoins on socket reconnection.
- The test mode is **1 km** (not 0.5 km) for a ~30 s harness race.

## 4. Server changes (done)

- `room.ts` — phase machine, host tracking + promotion, countdown cadence, finish detection + `matchResult` (replayed to rejoining players), reservations (45 s), result hold (8 s), `lastResult` persistence.
- `server.ts` — `RoomManager` (code-keyed map, code alphabet without `0O1IL`), socket→player mapping for stable playerIds, rate limits (join 5/min, rejoin 10/min), name/settings validation, token registry, empty-room destruction.
- Stable `playerId` decoupled from socket id; broadcasts target the io room so a reconnected socket just re-joins it.

## 5. Client changes (done)

- `Net.ts` — ack-based create/join/rejoin, token persistence (`hr.token`), auto-rejoin on reconnect, `startMatch`/`rematch`/`leaveRoom` emitters.
- `Hud.ts` + `style.css` — menu (name, SOLO / CREATE / JOIN with 5-char input), lobby (code, player list, host badges, host-only settings + START), countdown, finish (`FINISHED #n · time`), result leaderboard (REMATCH for host / MENU), reconnect chip, race meta chip (`10 km · 5.2/10 km · #3`).
- `Game.ts` — `NetPhase` machine (`none/lobby/countdown/racing/finished`), `startRaceFlow` (fresh match vs mid-race rejoin), rank + distance chip from snapshots, solo disconnects the socket, keydown "any key starts" removed (menu inputs).

## 6. Security & robustness (done)

- All server mutations host/phase-guarded; every payload validated (name 1–16 trimmed + control chars stripped; mode whitelist; density clamp; code regex).
- Rate limits: create/join 5/min/socket, rejoin 10/min; token is 12 random hex bytes, bound to playerId at join, revoked on leave.
- Rooms destroyed when empty; reservations expire in a 1 s sweep; no unbounded maps.

## 7. Testing (done)

- `verify-rooms.ts` PASS: codes, 6-player cap, bogus-code rejection, non-host start ignored, countdown 4..1, all 6 finish with unique ranks + ordered result, rematch → lobby, host promotion, AFK racer forfeits as DNF instead of blocking the result, mid-race reservation + token rejoin (playerId preserved), forged-token rejection, reserved seats don't stall the result or leak into the reopened lobby, stale tokens rejected.
- mp-check PASS / verify-mp PASS / verify-packs PASS (unchanged criteria).
- Remaining: manual acceptance — 6 mixed browser/Android devices complete a 40 km match (PLAN.md §5).

## 8. Files

- `packages/shared/src/protocol.ts`, `packages/shared/src/types.ts`
- `apps/game-server/src/room.ts`, `apps/game-server/src/server.ts`
- `apps/client/src/game/Net.ts`, `apps/client/src/game/Game.ts`, `apps/client/src/game/Hud.ts`, `apps/client/src/style.css`, `apps/client/src/main.ts`
- `apps/game-server/room-flow.ts`, `apps/game-server/verify-rooms.ts` (new), `docs/network-protocol.md`, `docs/phase3-plan.md`

