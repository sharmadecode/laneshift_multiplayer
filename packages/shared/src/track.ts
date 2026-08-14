export const TRACK_PERIOD = 2000; // 5 rich biomes x 400m each

/**
 * Returns the road curvature at world distance `dist`.
 * - Negative values = curving left (-1.0 to 0.0)
 * - Positive values = curving right (0.0 to +1.0)
 * - 0 = straightaway
 */
export function getTrackCurvature(dist: number): number {
  const d = ((dist % TRACK_PERIOD) + TRACK_PERIOD) % TRACK_PERIOD;

  // Biome 0: Downtown Metropolis (0 - 400m)
  if (d < 110) return 0; // high-speed straight
  if (d < 270) {
    // Smooth right sweep
    const t = (d - 110) / 160;
    return Math.sin(t * Math.PI) * 0.34;
  }
  if (d < 400) return 0;

  // Biome 1: Commercial Strip & Highway Overpass (400 - 800m)
  if (d < 540) {
    // Sweeping left turn
    const t = (d - 400) / 140;
    return -Math.sin(t * Math.PI) * 0.42;
  }
  if (d < 680) {
    // High-speed right chicane
    const t = (d - 540) / 140;
    return Math.sin(t * Math.PI) * 0.46;
  }
  if (d < 800) return 0;

  // Biome 2: Suburban Villas (800 - 1200m)
  if (d < 980) {
    // Gentle residential S-bend
    const t = (d - 800) / 180;
    return Math.sin(t * Math.PI * 2) * 0.36;
  }
  if (d < 1140) {
    // Wide tree-lined boulevard left curve
    const t = (d - 980) / 160;
    return -Math.sin(t * Math.PI) * 0.35;
  }
  if (d < 1200) return 0;

  // Biome 3: Forest Canyon Mountain Pass (1200 - 1600m)
  if (d < 1330) {
    // Sharp mountain right bend
    const t = (d - 1200) / 130;
    return Math.sin(t * Math.PI) * 0.58;
  }
  if (d < 1470) {
    // Rapid forest left hairpin
    const t = (d - 1330) / 140;
    return -Math.sin(t * Math.PI) * 0.65;
  }
  if (d < 1600) {
    // Fast uphill S-curve
    const t = (d - 1470) / 130;
    return Math.sin(t * Math.PI * 2) * 0.45;
  }

  // Biome 4: Farmland & Countryside Hairpin (1600 - 2000m)
  if (d < 1740) {
    // Countryside left sweep
    const t = (d - 1600) / 140;
    return -Math.sin(t * Math.PI) * 0.40;
  }
  if (d < 1880) {
    // Grand country hairpin turn
    const t = (d - 1740) / 140;
    return Math.sin(t * Math.PI) * 0.70;
  }
  // 1880 - 2000: Finish straightaway
  return 0;
}

/**
 * Calculates the lateral displacement offset (m) at relative depth `depth` (distance ahead)
 * relative to the player at `playerDist`.
 */
export function getCurveOffset(playerDist: number, depth: number): number {
  if (depth <= 0) return 0;
  const c0 = getTrackCurvature(playerDist);
  const c1 = getTrackCurvature(playerDist + depth * 0.4);
  const c2 = getTrackCurvature(playerDist + depth * 0.8);
  const avgCurve = c0 * 0.35 + c1 * 0.45 + c2 * 0.2;
  return avgCurve * (depth * depth * 0.00042);
}

/**
 * Calculates the tangent yaw angle (radians) at relative depth `depth`.
 */
export function getCurveYaw(playerDist: number, depth: number): number {
  const c = getTrackCurvature(playerDist + depth * 0.5);
  return c * Math.min(1.0, depth / 80) * 0.28;
}
