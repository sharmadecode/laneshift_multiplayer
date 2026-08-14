import { io, type Socket } from 'socket.io-client';
import { NET_EVENTS, type RoomSettings, type RoomStateMsg } from '@hr/shared';

// Shared Phase 3 protocol flow for the acceptance harnesses: connect ->
// welcome -> create/join -> (host) startMatch -> countdown -> matchStart.
// The server no longer auto-joins a room, so every harness drives this flow.

export const HARNESS_URL = 'http://localhost:5200';

export interface Joined {
  playerId: string;
  token: string;
  roomId: string;
}

export function mkSocket(): Socket {
  const s = io(HARNESS_URL, { transports: ['websocket'] });
  // Welcome can arrive before a harness gets around to joinRoom(); track it so
  // joinRoom can emit immediately instead of waiting for an event already sent.
  (s as unknown as { __welcomed?: boolean }).__welcomed = false;
  s.on(NET_EVENTS.welcome, () => {
    (s as unknown as { __welcomed?: boolean }).__welcomed = true;
  });
  return s;
}

/** Connect + welcome, then create (code undefined) or join a room. */
export function joinRoom(sock: Socket, name: string, code?: string): Promise<Joined> {
  return ackJoin(sock, code ? { code, name } : { name }, code ? NET_EVENTS.joinRoom : NET_EVENTS.createRoom);
}

/** Connect + welcome, then QUICK JOIN an open session (server creates one if none). */
export function quickJoin(sock: Socket, name: string): Promise<Joined> {
  return ackJoin(sock, { name }, NET_EVENTS.quickJoin);
}

function ackJoin(sock: Socket, payload: { name: string; code?: string }, event: string): Promise<Joined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join ack timeout')), 6000);
    let done = false;
    const finish = (r: Joined | null, err?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(new Error(err));
      else resolve(r as Joined);
    };
    const emit = (): void => {
      sock.emit(
        event,
        payload,
        (r: { ok: boolean; error?: string; token?: string; roomId?: string; playerId?: string } | undefined) => {
          if (!r?.ok) {
            finish(null, r?.error ?? 'join failed');
            return;
          }
          finish({ playerId: r.playerId as string, token: r.token as string, roomId: r.roomId as string });
        }
      );
    };
    if ((sock as unknown as { __welcomed?: boolean }).__welcomed) emit();
    else sock.once(NET_EVENTS.welcome, emit);
  });
}

/** Emit startMatch (host only) and resolve when the countdown ends. */
export function waitMatchStart(sock: Socket, settings: RoomSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('matchStart timeout')), 15000);
    sock.once(NET_EVENTS.matchStart, () => {
      clearTimeout(timer);
      resolve();
    });
    sock.emit(NET_EVENTS.startMatch, { settings });
  });
}

export function waitRoomState(sock: Socket, timeoutMs = 6000): Promise<RoomStateMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('roomState timeout')), timeoutMs);
    sock.once(NET_EVENTS.roomState, (s: RoomStateMsg) => {
      clearTimeout(timer);
      resolve(s);
    });
  });
}

/** Wait for a countdown event (or timeout). */
export function waitCountdown(sock: Socket, timeoutMs = 6000): Promise<{ t: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('countdown timeout')), timeoutMs);
    sock.once(NET_EVENTS.countdown, (m: { t: number }) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
}
