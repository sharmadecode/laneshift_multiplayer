import { CAR_LENGTH, CAR_WIDTH, COLLISION_SCALE } from '@hr/shared';
import type { TrafficCar } from './traffic.js';

/**
 * 2D capsule-ish collision check between the player and a traffic car.
 * Player sits at (playerX, relZ=0). Car relZ is negative when ahead.
 */
export function playerHitsCar(
  playerX: number,
  carX: number,
  carRelZ: number,
  carLen: number,
  carWidth: number
): boolean {
  const halfLen = ((CAR_LENGTH + carLen) / 2) * COLLISION_SCALE;
  const halfWid = ((CAR_WIDTH + carWidth) / 2) * COLLISION_SCALE;
  return Math.abs(carRelZ) < halfLen && Math.abs(carX - playerX) < halfWid;
}

export function playerHitsTraffic(
  playerX: number,
  cars: TrafficCar[],
  playerDist: number,
  hit: (car: TrafficCar) => void
): boolean {
  for (const c of cars) {
    if (playerHitsCar(playerX, c.x, relZFor(c, playerDist), c.length, c.width)) {
      hit(c);
      return true;
    }
  }
  return false;
}

function relZFor(c: TrafficCar, playerDist: number): number {
  return -(c.roadDist - playerDist);
}
