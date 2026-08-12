/** Pure data shapes shared by server + client (no logic). */

export interface TrafficCar {
  id: number;
  lane: number; // -1 | 0 | 1
  x: number; // absolute lateral position (m), lane center + drift
  roadDist: number; // absolute position on the road (meters)
  speed: number; // m/s
  length: number;
  width: number;
  modelIndex: number;
  colorIndex: number;
}
