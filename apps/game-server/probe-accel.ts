import { io } from 'socket.io-client';
import { NET_EVENTS, type WorldSnapshot } from '@hr/shared';

// Probe: create a room, start a 1 km match, send full throttle at 30 Hz,
// watch the player's speed in server snapshots for 6 s.
const s = io('http://localhost:5200', { transports: ['websocket'] });

function die(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}

s.on(NET_EVENTS.welcome, () => {
  s.emit(NET_EVENTS.createRoom, { name: 'PROBE' }, (r: { ok: boolean; token?: string; roomId?: string; playerId?: string; error?: string }) => {
    if (!r?.ok) die(`create failed: ${r?.error}`);
    s.emit(NET_EVENTS.startMatch, { settings: { mode: 1, density: 0.8 } });
  });
});

let snapCount = 0;
let maxSpeed = 0;
let sawFirst = false;
let sent = 0;
let seq = 0;

s.on(NET_EVENTS.snapshot, (snap: WorldSnapshot) => {
  snapCount++;
  const me = snap.players.find((p) => p.id === (s.id as string));
  if (me) {
    sawFirst = true;
    maxSpeed = Math.max(maxSpeed, me.speed);
  }
});

const throttle = setInterval(() => {
  s.emit('in', { steering: 0, throttle: 1, brake: 0, seq: seq++ });
  sent++;
}, 33);

setTimeout(() => {
  clearInterval(throttle);
  console.log(`snapshots received: ${snapCount}, inputs sent: ${sent}, saw self: ${sawFirst}, max speed: ${maxSpeed.toFixed(1)} m/s`);
  if (!sawFirst) die('player never appeared in a snapshot');
  if (maxSpeed < 30) die(`car barely accelerated (max ${maxSpeed.toFixed(1)} m/s) — server-side acceleration broken`);
  console.log('PASS: server accelerates a throttling car to top speed');
  process.exit(0);
}, 7000);
