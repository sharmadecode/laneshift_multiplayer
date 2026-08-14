export const TRACK_PERIOD = 2000; // 5 rich biomes x 400m each

/**
 * Smoothstep Hermite interpolation (3t^2 - 2t^3) for butter-smooth curve entry and exit.
 */
function smoothArc(t: number, amplitude: number): number {
  if (t <= 0 || t >= 1) return 0;
  // Sinusoidal bell curve with smoothstep envelope
  const envelope = Math.sin(t * Math.PI);
  return envelope * envelope * amplitude;
}

/**
 * Returns the road curvature at world distance `dist`.
 * - Negative values = curving left (-1.0 to 0.0)
 * - Positive values = curving right (0.0 to +1.0)
 * - 0 = straightaway
 *
 * Designed with long, wide, sustained highway arcs (300m - 400m per turn)
 * and relaxing straightaways, eliminating rapid twitchy direction changes.
 */
export function getTrackCurvature(dist: number): number {
  const d = ((dist % TRACK_PERIOD) + TRACK_PERIOD) % TRACK_PERIOD;

  // Biome 0: Downtown Metropolis (0 - 400m)
  // Long straight start (0-150m) -> Gentle wide right highway sweep (150m-380m)
  if (d >= 150 && d < 380) {
    const t = (d - 150) / 230;
    return smoothArc(t, 0.22);
  }

  // Biome 1: Commercial Strip (400 - 800m)
  // Straight (380-520m) -> Wide, majestic sweeping left overpass (520m-780m)
  if (d >= 520 && d < 780) {
    const t = (d - 520) / 260;
    return smoothArc(t, -0.24);
  }

  // Biome 2: Suburban Villas (800 - 1200m)
  // Straight (780-920m) -> Gentle tree-lined boulevard right arc (920m-1160m)
  if (d >= 920 && d < 1160) {
    const t = (d - 920) / 240;
    return smoothArc(t, 0.20);
  }

  // Biome 3: Forest Canyon (1200 - 1600m)
  // Straight (1160-1280m) -> Long scenic forest left curve (1280m-1560m)
  if (d >= 1280 && d < 1560) {
    const t = (d - 1280) / 280;
    return smoothArc(t, -0.25);
  }

  // Biome 4: Countryside & Farmland (1600 - 2000m)
  // Straight (1560-1680m) -> Wide countryside right bend (1680m-1920m) -> Finish straight (1920m-2000m)
  if (d >= 1680 && d < 1920) {
    const t = (d - 1680) / 240;
    return smoothArc(t, 0.22);
  }

  // Pure straightaways
  return 0;
}

/**
 * Calculates the lateral displacement offset (m) at relative depth `depth` (distance ahead)
 * relative to the player at `playerDist`.
 */
export function getCurveOffset(playerDist: number, depth: number): number {
  if (depth <= 0) return 0;
  const c0 = getTrackCurvature(playerDist);
  const c1 = getTrackCurvature(playerDist + depth * 0.45);
  const c2 = getTrackCurvature(playerDist + depth * 0.9);
  const avgCurve = c0 * 0.35 + c1 * 0.45 + c2 * 0.2;
  return avgCurve * (depth * depth * 0.00018);
}

/**
 * Calculates the tangent yaw angle (radians) at relative depth `depth`.
 */
export function getCurveYaw(playerDist: number, depth: number): number {
  const c = getTrackCurvature(playerDist + depth * 0.5);
  return c * Math.min(1.0, depth / 120) * 0.12;
}
