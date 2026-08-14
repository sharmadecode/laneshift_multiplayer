import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { Server, type Socket as ServerSocket } from 'socket.io';
import sirv from 'sirv';
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

// Static client handler for Render production deployment
const clientDist = fileURLToPath(new URL('../../client/dist', import.meta.url));
const staticServe = existsSync(clientDist) ? sirv(clientDist, { single: true }) : null;

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
    return;
  }
  if (staticServe) {
    staticServe(req, res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LaneShifter Multiplayer Game Server Running');
  }
});

const customAllowed = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim().toLowerCase())
  : [];

function allowedOrigin(origin: string | undefined, callback: (err: Error | null, origin?: string | boolean) => void): void {
  // Non-browser clients (harnesses) send no origin.
  if (!origin) {
    callback(null, true);
    return;
  }
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      callback(null, true);
      return;
    }
    // Private LAN hosts (dev: phone hits the PC's LAN IP)
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      callback(null, true);
      return;
    }
    // Render cloud domains (*.onrender.com) or custom configured origins
    if (host.endsWith('.onrender.com') || customAllowed.includes(origin.toLowerCase()) || customAllowed.includes(host)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  } catch {
    callback(null, false);
  }
}

const io = new Server(httpServer, {
  cors: { origin: allowedOrigin },
  maxHttpBufferSize: 1024
});

const rooms = new Map<string, Room>();
const socketToPlayer = new Map<string, { playerId: string; roomId: string }>();
const tokens = new Map<string, { playerId: string; roomId: string }>();
const joinAttempts = new Map<string, number[]>();
const rejoinAttempts = new Map<string, number[]>();
const ipJoinAttempts = new Map<string, number[]>();
const IP_JOIN_RATE_MAX = 30;

function pruneRateLimiter(bucket: Map<string, number[]>, now: number): void {
  for (const [key, timestamps] of bucket) {
    const recent = timestamps.filter((t) => now - t < 60_000);
    if (!recent.length) bucket.delete(key);
    else bucket.set(key, recent);
  }
}

function removeTokensForRoom(roomId: string): void {
  for (const [token, info] of tokens) {
    if (info.roomId === roomId) tokens.delete(token);
  }
}

// Periodic cleanup to keep memory usage minimal on free-tier hosts
setInterval(() => {
  const now = Date.now();
  pruneRateLimiter(joinAttempts, now);
  pruneRateLimiter(rejoinAttempts, now);
  pruneRateLimiter(ipJoinAttempts, now);
  for (const [token, info] of tokens) {
    if (!rooms.has(info.roomId)) tokens.delete(token);
  }
}, 30_000);

function leaveOtherRooms(socket: ServerSocket): void {
  for (const r of socket.rooms) {
    if (r !== socket.id) socket.leave(r);
  }
}

/**
 * Moves a socket from its current room (if any) into another, cleaning up the
 * old room's player entry, its reconnect token, and its socket.io room
 * membership. Guarantees exactly one room per socket at all times.
 */
function switchRoom(socket: ServerSocket, nextRoomId: string, nextPlayerId = socket.id): void {
  const prev = socketToPlayer.get(socket.id);
  if (prev && prev.roomId !== nextRoomId) {
    const prevRoom = rooms.get(prev.roomId);
    if (prevRoom) {
      if (prevRoom.phase === 'racing' || prevRoom.phase === 'finished') {
        // Mid-race: leave a reserved seat so the match still ends cleanly.
        if (prevRoom.players.has(prev.playerId)) prevRoom.onDisconnect(prev.playerId);
      } else {
        prevRoom.removePlayer(prev.playerId);
      }
    }
    removeTokenFor(prev.playerId);
  }
  leaveOtherRooms(socket);
  socketToPlayer.set(socket.id, { playerId: nextPlayerId, roomId: nextRoomId });
}

function genCode(): string {
  for (let i = 0; i < 20; i++) {
    const code = genCodeOnce();
    if (!rooms.has(code)) return code;
  }
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
 * Finds the optimal open room for quick join.
 * Priorities: 1. Racing rooms (spawn at back), 2. Countdown rooms, 3. Lobby rooms.
 */
function quickJoinTarget(): Room | null {
  let best: Room | null = null;
  let bestRank = -1;
  let bestSize = -1;
  for (const room of rooms.values()) {
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
  const steerOk = typeof m.steering === 'number' && Number.isFinite(m.steering) && m.steering >= -1.5 && m.steering <= 1.5;
  const throttleOk = typeof m.throttle === 'number' && Number.isFinite(m.throttle) && m.throttle >= 0 && m.throttle <= 1;
  const brakeOk = typeof m.brake === 'number' && Number.isFinite(m.brake) && m.brake >= 0 && m.brake <= 1;
  return (
    typeof m.seq === 'number' &&
    Number.isInteger(m.seq) &&
    m.seq >= 0 &&
    m.seq <= Number.MAX_SAFE_INTEGER &&
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

/** Per-socket AND per-IP join budget: socket ids are cheap to mint, IPs are not. */
function joinRateLimited(socket: ServerSocket, now: number): boolean {
  if (rateLimited(joinAttempts, socket.id, ROOM_JOIN_RATE_MAX, now)) return true;
  const ip = socket.handshake.address;
  return rateLimited(ipJoinAttempts, ip, IP_JOIN_RATE_MAX, now);
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
    if (!name || joinRateLimited(socket, Date.now())) {
      ack?.({ ok: false, error: 'too many join attempts' });
      return;
    }
    const code = genCode();
    const room = new Room((event, payload) => io.to(code).emit(event, payload), code);
    rooms.set(code, room);
    room.hostId = socket.id;
    switchRoom(socket, code);
    socket.join(code);
    room.addPlayer(socket.id, name);
    const token = genToken();
    tokens.set(token, { playerId: socket.id, roomId: code });
    ack?.({ ok: true, token, roomId: code, playerId: socket.id });
  });

  socket.on(NET_EVENTS.joinRoom, (msg: unknown, ack?: (r: unknown) => void) => {
    const name = sanitizeName((msg as JoinRoomMsg)?.name);
    const code = typeof (msg as JoinRoomMsg)?.code === 'string' ? (msg as JoinRoomMsg).code.trim().toUpperCase() : '';
    if (!name || !/^[A-Z2-9]{5}$/.test(code) || joinRateLimited(socket, Date.now())) {
      ack?.({ ok: false, error: 'bad request' });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      ack?.({ ok: false, error: 'room not found' });
      return;
    }
    if (room.players.size - room.reservations.size >= ROOM_MAX_PLAYERS) {
      ack?.({ ok: false, error: 'room full' });
      return;
    }
    switchRoom(socket, code);
    socket.join(code);
    if (room.phase === 'racing' || room.phase === 'finished') {
      room.addJoiner(socket.id, name);
    } else {
      room.addPlayer(socket.id, name);
    }
    const token = genToken();
    tokens.set(token, { playerId: socket.id, roomId: code });
    if (room.lastResult && room.phase === 'finished') socket.emit(NET_EVENTS.matchResult, room.lastResult);
    ack?.({ ok: true, token, roomId: code, playerId: socket.id });
  });

  socket.on(NET_EVENTS.quickJoin, (msg: unknown, ack?: (r: unknown) => void) => {
    const name = sanitizeName((msg as QuickJoinMsg)?.name);
    if (!name || joinRateLimited(socket, Date.now())) {
      ack?.({ ok: false, error: 'bad request' });
      return;
    }
    const target = quickJoinTarget();
    if (!target) {
      const code = genCode();
      const room = new Room((event, payload) => io.to(code).emit(event, payload), code);
      room.settings = { mode: 'endless', density: 1.0 };
      rooms.set(code, room);
      room.hostId = socket.id;
      switchRoom(socket, code);
      socket.join(code);
      room.addPlayer(socket.id, name);
      const token = genToken();
      tokens.set(token, { playerId: socket.id, roomId: code });
      ack?.({ ok: true, token, roomId: code, playerId: socket.id });
      return;
    }

    switchRoom(socket, target.code);
    socket.join(target.code);
    if (target.phase === 'racing' || target.phase === 'finished') {
      target.addJoiner(socket.id, name);
    } else {
      target.addPlayer(socket.id, name);
    }
    const token = genToken();
    tokens.set(token, { playerId: socket.id, roomId: target.code });
    if (target.lastResult && target.phase === 'finished') socket.emit(NET_EVENTS.matchResult, target.lastResult);
    ack?.({ ok: true, token, roomId: target.code, playerId: socket.id });
  });

  socket.on(NET_EVENTS.rejoinRoom, (msg: unknown, ack?: (r: unknown) => void) => {
    const m = msg as RejoinRoomMsg;
    if (typeof m?.roomId !== 'string' || typeof m?.token !== 'string' || rateLimited(rejoinAttempts, socket.id, REJOIN_RATE_MAX, Date.now())) {
      ack?.({ ok: false, error: 'bad request' });
      return;
    }
    const info = tokens.get(m.token);
    if (!info || info.roomId !== m.roomId) {
      ack?.({ ok: false, error: 'rejoin expired' });
      return;
    }
    const room = rooms.get(m.roomId);
    if (!room || !room.players.has(info.playerId) || !room.isReserved(info.playerId)) {
      tokens.delete(m.token);
      ack?.({ ok: false, error: 'rejoin expired' });
      return;
    }

    switchRoom(socket, room.code, info.playerId);
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

// Fixed 30 Hz simulation loop with wall-clock drift compensation
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
      try {
        room.tick(SIM_DT);
      } catch (err) {
        // One hostile/buggy room must never take down the whole server.
        console.error(`[room ${room.code}] tick crashed, dropping room:`, err);
        removeTokensForRoom(room.code);
        for (const pid of [...room.players.keys()]) removeTokenFor(pid);
        rooms.delete(room.code);
        continue;
      }
      if (!room.players.size) {
        removeTokensForRoom(room.code);
        rooms.delete(room.code);
      }
    }
  }
}, 5);

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});

httpServer.listen(PORT, () => {
  console.log(`LaneShifter multiplayer game server listening on :${PORT}`);
});
