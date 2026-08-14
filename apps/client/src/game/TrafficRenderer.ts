import * as THREE from 'three';
import { absZ, type TrafficCar } from '@hr/simulation';
import { createCarMesh } from './CarMesh';

export const TRAFFIC_COLORS = [
  0xe74c3c, 0x3498db, 0xf1c40f, 0x2ecc71, 0x9b59b6, 0xe67e22, 0x34495e, 0xf8fafc
];

export class TrafficRenderer {
  private pool = new Map<number, THREE.Group>();
  private used = new Set<number>();

  constructor(private scene: THREE.Scene) {}

  sync(cars: TrafficCar[], playerDist: number): void {
    this.used.clear();
    for (const car of cars) {
      let mesh = this.pool.get(car.id);
      if (!mesh) {
        const types: ('sedan' | 'suv' | 'hatchback')[] = ['sedan', 'suv', 'hatchback', 'sedan'];
        const type = types[car.id % types.length];
        mesh = createCarMesh({
          color: TRAFFIC_COLORS[car.colorIndex % TRAFFIC_COLORS.length],
          type
        });
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

    // Prune unused meshes to prevent unbounded memory growth in long runs
    if (this.pool.size > 50) {
      for (const [id, mesh] of this.pool) {
        if (!this.used.has(id)) {
          this.scene.remove(mesh);
          mesh.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.geometry?.dispose();
              if (Array.isArray(o.material)) {
                for (const m of o.material) m.dispose();
              } else if (o.material) {
                o.material.dispose();
              }
            }
          });
          this.pool.delete(id);
        }
      }
    }
  }
}
