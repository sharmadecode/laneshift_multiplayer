import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { INPUT_RATE_MAX, NET_EVENTS, TICK_RATE, type InputMsg } from '@hr/shared';
import { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 5200);

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: true },
  maxHttpBufferSize: 1024
});

const rooms = new Map<string, Room>();

function getOrCreateRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = new Room((event, payload) => io.to(id).emit(event, payload), id);
    rooms.set(id, room);
  }
  return room;
}

// Phase 2: one shared room for everyone. Codes, lobbies and countdowns land in Phase 3.
const DEFAULT_ROOM = getOrCreateRoom('rush');

// Fixed 30 Hz simulation tick across all rooms.
setInterval(() => {
  const dt = 1 / TICK_RATE;
  for (const room of rooms.values()) room.tick(dt);
}, 1000 / TICK_RATE);

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

io.on('connection', (socket) => {
  const name = `Player-${Math.floor(100 + Math.random() * 900)}`;
  const player = DEFAULT_ROOM.addPlayer(socket.id, name);
  socket.join(DEFAULT_ROOM.id);
  socket.emit(NET_EVENTS.welcome, {
    playerId: socket.id,
    roomId: DEFAULT_ROOM.id,
    players: DEFAULT_ROOM.playerList()
  });

  let lastInputAt = 0;
  socket.on(NET_EVENTS.input, (msg: unknown) => {
    const now = Date.now();
    if (now - lastInputAt < 1000 / INPUT_RATE_MAX) return;
    lastInputAt = now;
    if (!isValidInput(msg)) return;
    DEFAULT_ROOM.setInput(socket.id, msg);
  });

  socket.on('disconnect', () => {
    DEFAULT_ROOM.removePlayer(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Highway Rush game server listening on :${PORT}`);
});
