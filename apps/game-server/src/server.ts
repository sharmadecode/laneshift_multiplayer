import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { Server, type Socket as ServerSocket } from 'socket.io';
import {
  DENSITY_MAX,
  DENSITY_MIN,
  INPUT_RATE_MAX,
  NAME_MAX_LEN,
  NET_EVENTS,
  REJOIN_RATE_MAX,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LEN,
  ROOM_JOIN_RATE_MAX,
  ROOM_MAX_PLAYERS,
  TICK_RATE,
  type CreateRoomMsg,
  type InputMsg,
  type JoinRoomMsg,
  type QuickJoinMsg,
  type RejoinRoomMsg,
  type RoomMode,
  type RoomSettings,
  type StartMatchMsg
} from '@hr/shared';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 5200);
const ROOM_MODES: RoomMode[] = ['endless', 1, 40, 60, 100];

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: true },
  maxHttpBufferSize: 1024
});

/** code -> Room */
const rooms = new Map<string, Room>();
/** socketId -> { playerId, roomId } (playerId survives socket reconnects) */
const socketToPlayer = new Map<string, { playerId: string; roomId: string }>();
/** token -> { playerId, roomId }; the client keeps it to rejoin after a drop */
const tokens = new Map<string, { playerId: string; roomId: string }>();
/** socketId -> timestamps of recent join/create attempts (rolling minute) */
const joinAttempts = new Map<string, number[]>();
/** socketId -> timestamps of recent rejoin attempts */
const rejoinAttempts = new Map<string, number[]>();

function leaveOtherRooms(socket: ServerSocket): void {
  // One room per socket: drop stale subscriptions from earlier joins so a
  // malicious client can't camp in old rooms, draining broadcasts to its socket.
  for (const r of socket.rooms) {
    if (r !== socket.id) socket.leave(r);
  }
}

function genCode(): string {
  for (let i = 0; i < 20; i++) {
    const code = genCodeOnce();
    if (!rooms.has(code)) return code;
  }
  // 32^5 codes exist; this fallback is unreachable in practice but must never
  // throw inside a socket handler (it would take down the whole server).
  let code = genCodeOnce();
  while (rooms.has(code)) code = genCodeOnce();
  return code;
}

function genCodeOnce(): string {
  let code = '';
  for (let j = 0; j < ROOM_CODE_LEN; j++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function genToken(): string {
  return randomBytes(12).toString('hex');
}

/**
 * QUICK JOIN candidate: an open session, best-fit first. Racing rooms win
 * (spawn at the back = instant play), then countdown (join at the line), then
 * the fullest lobby room, then finished rooms (result hold — the lobby and a
 * rematch follow within seconds).
 */
function quickJoinTarget(): Room | null {
  let best: Room | null = null;
  let bestRank = -1;
  let bestSize = -1;
  for (const room of rooms.values()) {
    // Reserved seats (dropout grace) do not block newcomers from filling a room.
    if (room.players.size - room.reservations.size >= ROOM_MAX_PLAYERS) continue;
    const rank = room.phase === 'racing' ? 3 : room.phase === 'countdown' ? 2 : room.phase === 'lobby' ? 1 : 0;
    if (rank > bestRank || (rank === bestRank && room.players.size > bestSize)) {
      best = room;
      bestRank = rank;
      bestSize = room.players.size;
    }
  }
  return best;
}

function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX_LEN);
  return name.length > 0 ? name : null;
}

function validateSettings(raw: unknown): RoomSettings | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (!ROOM_MODES.includes(m.mode as RoomMode)) return null;
  if (typeof m.density !== 'number' || !Number.isFinite(m.density)) return null;
  return {
    mode: m.mode as RoomMode,
    density: Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, m.density))
  };
}

function isValidInput(msg: unknown): msg is InputMsg {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  const steerOk = m.steering === -1 || m.steering === 0 || m.steering === 1;
  const throttleOk = typeof m.throttle === 'number' && Number.isFinite(m.throttle) && m.throttle >= 0 && m.throttle <= 1;
  const brakeOk = typeof m.brake === 'number' && Number.isFinite(m.brake) && m.brake >= 0 && m.brake <= 1;
  return (
    typeof m.seq === 'number' &&
    Number.isFinite(m.seq) &&
    steerOk &&
    throttleOk &&
    brakeOk
  );
}

function rateLimited(bucket: Map<string, number[]>, socketId: string, max: number, now: number): boolean {
  const recent = (bucket.get(socketId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= max) {
    bucket.set(socketId, recent);
    return true;
  }
  recent.push(now);
  bucket.set(socketId, recent);
  return false;
}

function removeTokenFor(playerId: string): void {
  for (const [token, info] of tokens) {
    if (info.playerId === playerId) tokens.delete(token);
  }
}

io.on('connection', (socket) => {
  socket.emit(NET_EVENTS.welcome, { playerId: socket.id });

  let lastInputAt = 0;

  socket.on(NET_EVENTS.createRoom, (msg: unknown, ack?: (r: unknown) => void) => {
    const name = sanitizeName((msg as CreateRoomMsg)?.name);
    if (!name || rateLimited(joinAttempts, socket.id, ROOM_JOIN_RATE_MAX, Date.now())) {
      ack?.({ ok: false, error: 'too many join attempts' });
      return;
    }
    const code = genCode();
    const room = new Room((event, payload) => io.to(code).emit(event, payload), code);
    rooms.set(code, room);
    room.hostId = socket.id;
    leaveOtherRooms(socket);
    socket.join(code); // join before addPlayer so the roomState broadcast reaches us
    room.addPlayer(socket.id, name);
    socketToPlayer.set(socket.id, { playerId: socket.id, roomId: code });
    const token = genToken();
    tokens.set(token, { playerId: socket.id, roomId: code });
    ack?.({ ok: true, token, roomId: code, playerId: socket.id });
  });

  socket.on(NET_EVENTS.joinRoom, (msg: unknown, ack?: (r: unknown) => void) => {
    const name = sanitizeName((msg as JoinRoomMsg)?.name);
    const code = typeof (msg as JoinRoomMsg)?.code === 'string' ? (msg as JoinRoomMsg).code.trim().toUpperCase() : '';
    if (!name || !/^[A-Z2-9]{5}$/.test(code) || rateLimited(joinAttempts, socket.id, ROOM_JOIN_RATE_MAX, Date.now())) {
      ack?.({ ok: false, error: 'bad request' });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      ack?.({ ok: false, error: 'room not found' });
      return;
    }
    if (!room.makeRoomFor()) {
      ack?.({ ok: false, error: 'room full' });
      return;
    }
    // Lobby/countdown joins start at the line; racing/finished joins spawn at
    // the back of the field (ghosted), so a friend can hop into an active race.
    leaveOtherRooms(socket);
    socket.join(code);
    if (room.phase === 'lobby' || room.phase === 'countdown') room.addPlayer(socket.id, name);
    else room.addJoiner(socket.id, name);
    if (room.lastResult && room.phase === 'finished') socket.emit(NET_EVENTS.matchResult, room.lastResult);
    socketToPlayer.set(socket.id, { playerId: socket.id, roomId: code });
    const token = genToken();
    tokens.set(token, { playerId: socket.id, roomId: code });
    ack?.({ ok: true, token, roomId: code, playerId: socket.id });
  });

  socket.on(NET_EVENTS.quickJoin, (msg: unknown, ack?: (r: unknown) => void) => {
    const name = sanitizeName((msg as QuickJoinMsg)?.name);
    if (!name || rateLimited(joinAttempts, socket.id, ROOM_JOIN_RATE_MAX, Date.now())) {
      ack?.({ ok: false, error: 'bad request' });
      return;
    }
    let room = quickJoinTarget();
    if (!room) {
      // No open session: start a fresh endless highway (the quick-join default).
      const code = genCode();
      room = new Room((event, payload) => io.to(code).emit(event, payload), code);
      rooms.set(code, room);
      room.hostId = socket.id;
      room.settings = { mode: 'endless', density: 1.0 };
    }
    if (!room.makeRoomFor()) {
      ack?.({ ok: false, error: 'room full' });
      return;
    }
    leaveOtherRooms(socket);
    socket.join(room.code);
    if (room.phase === 'lobby' || room.phase === 'countdown') room.addPlayer(socket.id, name);
    else room.addJoiner(socket.id, name);
    if (room.lastResult && room.phase === 'finished') socket.emit(NET_EVENTS.matchResult, room.lastResult);
    socketToPlayer.set(socket.id, { playerId: socket.id, roomId: room.code });
    const token = genToken();
    tokens.set(token, { playerId: socket.id, roomId: room.code });
    ack?.({ ok: true, token, roomId: room.code, playerId: socket.id });
  });

  socket.on(NET_EVENTS.rejoinRoom, (msg: unknown, ack?: (r: unknown) => void) => {
    const m = msg as RejoinRoomMsg;
    if (
      typeof m?.roomId !== 'string' ||
      typeof m?.token !== 'string' ||
      rateLimited(rejoinAttempts, socket.id, REJOIN_RATE_MAX, Date.now())
    ) {
      ack?.({ ok: false, error: 'bad request' });
      return;
    }
    const info = tokens.get(m.token);
    const room = info ? rooms.get(info.roomId) : undefined;
    if (!info || !room || !room.players.has(info.playerId) || !room.isReserved(info.playerId)) {
      ack?.({ ok: false, error: 'rejoin expired' });
      return;
    }
    socketToPlayer.set(socket.id, { playerId: info.playerId, roomId: room.code });
    leaveOtherRooms(socket);
    socket.join(room.code);
    room.clearReservation(info.playerId);
    socket.emit(NET_EVENTS.roomState, room.toRoomState());
    if (room.lastResult && room.phase === 'finished') socket.emit(NET_EVENTS.matchResult, room.lastResult);
    ack?.({ ok: true, token: m.token, roomId: room.code, playerId: info.playerId });
  });

  socket.on(NET_EVENTS.startMatch, (msg: unknown) => {
    const entry = socketToPlayer.get(socket.id);
    const pid = entry?.playerId;
    const room = entry ? rooms.get(entry.roomId) : undefined;
    if (!room || !pid || room.hostId !== pid || room.phase !== 'lobby') return;
    const settings = validateSettings((msg as StartMatchMsg)?.settings);
    if (!settings) return;
    room.startCountdown(settings);
  });

  socket.on(NET_EVENTS.rematch, () => {
    const entry = socketToPlayer.get(socket.id);
    const pid = entry?.playerId;
    const room = entry ? rooms.get(entry.roomId) : undefined;
    if (!room || !pid || room.hostId !== pid || room.phase !== 'finished') return;
    room.rematch();
  });

  socket.on(NET_EVENTS.leaveRoom, () => {
    const entry = socketToPlayer.get(socket.id);
    const pid = entry?.playerId;
    const room = entry ? rooms.get(entry.roomId) : undefined;
    if (!room || !pid || !room.players.has(pid)) return;
    room.removePlayer(pid);
    socket.leave(room.code);
    socketToPlayer.delete(socket.id);
    removeTokenFor(pid);
  });

  socket.on(NET_EVENTS.input, (msg: unknown) => {
    const now = Date.now();
    if (now - lastInputAt < 1000 / INPUT_RATE_MAX) return;
    lastInputAt = now;
    if (!isValidInput(msg)) return;
    const entry = socketToPlayer.get(socket.id);
    const room = entry ? rooms.get(entry.roomId) : undefined;
    if (room && entry) room.setInput(entry.playerId, msg);
  });

  socket.on('disconnect', () => {
    const entry = socketToPlayer.get(socket.id);
    if (entry) {
      const room = rooms.get(entry.roomId);
      room?.onDisconnect(entry.playerId);
      socketToPlayer.delete(socket.id);
    }
    joinAttempts.delete(socket.id);
    rejoinAttempts.delete(socket.id);
  });
});

// Fixed 30 Hz simulation tick across all rooms, driven by a wall-clock
// accumulator. Bare setInterval drifts on Windows: a 16 ms OS timer granularity
// clamps a 33 ms interval to ~47 ms (~21 Hz), which slows the whole world and
// drags snapshots down to ~15/s instead of the designed 20/s.
const SIM_DT = 1 / TICK_RATE;
let simAcc = 0;
let simLast = performance.now();
setInterval(() => {
  const now = performance.now();
  simAcc += Math.min(0.25, (now - simLast) / 1000);
  simLast = now;
  while (simAcc >= SIM_DT) {
    simAcc -= SIM_DT;
    for (const room of rooms.values()) {
      room.tick(SIM_DT);
      if (!room.players.size) {
        // A dead room must take its players' reconnect tokens with it,
        // otherwise the token map leaks and stale tokens stay replayable.
        for (const pid of room.players.keys()) removeTokenFor(pid);
        rooms.delete(room.code);
      }
    }
  }
}, 5);

httpServer.listen(PORT, () => {
  console.log(`Highway Rush game server listening on :${PORT}`);
});
