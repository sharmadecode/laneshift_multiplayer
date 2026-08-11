import * as THREE from 'three';
import { absZ, type TrafficSpawner } from '@hr/simulation';
import { createCarMesh } from './CarMesh';

const TRAFFIC_COLORS = [
  0x9aa5b1, 0xc0392b, 0x2c3e50, 0x2980b9, 0xf1c40f, 0x8e44ad, 0x27ae60, 0xecf0f1
];

export class TrafficRenderer {
  private pool = new Map<number, THREE.Group>();
  private used = new Set<number>();

  constructor(private scene: THREE.Scene, private spawner: TrafficSpawner) {}

  sync(playerDist: number): void {
    this.used.clear();
    for (const car of this.spawner.cars) {
      let mesh = this.pool.get(car.id);
      if (!mesh) {
        mesh = createCarMesh({ color: TRAFFIC_COLORS[car.colorIndex % TRAFFIC_COLORS.length] });
        mesh.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        this.scene.add(mesh);
        this.pool.set(car.id, mesh);
      }
      mesh.visible = true;
      mesh.position.set(car.x, 0, absZ(car, playerDist));
      this.used.add(car.id);
    }
    for (const [id, mesh] of this.pool) {
      if (!this.used.has(id)) mesh.visible = false;
    }
  }
}
