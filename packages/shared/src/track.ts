export function getTrackCurvature(s: number): number {
  return 0;
}

export function getCurveOffset(playerDist: number, ahead: number): number {
  return 0;
}

export function getCurveYaw(playerDist: number, ahead: number): number {
  return 0;
}

export function getRelativeTrackPoint(
  playerDist: number,
  targetDist: number,
  lateralOffset = 0
): { x: number; z: number; yaw: number } {
  const ahead = targetDist - playerDist;
  return {
    x: lateralOffset,
    z: -ahead,
    yaw: 0
  };
}
