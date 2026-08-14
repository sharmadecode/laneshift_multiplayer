import * as THREE from 'three';
import { absZ, type TrafficCar } from '@hr/simulation';
import { getCurveOffset, getCurveYaw } from '@hr/shared';
import { createCarMesh } from './CarMesh';
import { assetLoader } from './AssetLoader';

export const TRAFFIC_COLORS = [
  0xef4444, 0x0284c7, 0xeab308, 0x10b981, 0xf8fafc, 0xf97316, 0x8b5cf6, 0x94a3b8
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
        const glbCar = assetLoader.createTrafficCarInstance(car.modelIndex ?? (car.id % 12));
        if (glbCar) {
          mesh = glbCar;
        } else {
          const color = TRAFFIC_COLORS[car.colorIndex % TRAFFIC_COLORS.length];
          const types: ('sedan' | 'suv' | 'hatchback' | 'van')[] = ['sedan', 'suv', 'hatchback', 'van'];
          const type = types[car.id % types.length];
          mesh = createCarMesh({ color, type });
          mesh.userData.isProcedural = true;
        }

        mesh.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        this.scene.add(mesh);
        this.pool.set(car.id, mesh);
      }
      mesh.visible = true;
      const z = absZ(car, playerDist);
      const curveX = getCurveOffset(playerDist, -z);
      const curveYaw = getCurveYaw(playerDist, -z);
      mesh.position.set(car.x + curveX, 0, z);
      mesh.rotation.y = Math.PI - curveYaw;
      this.used.add(car.id);
    }

    for (const [id, mesh] of this.pool) {
      if (!this.used.has(id)) mesh.visible = false;
    }

    // Prune unused meshes from scene to keep pool lean without destroying shared GLTF assets
    if (this.pool.size > 50) {
      for (const [id, mesh] of this.pool) {
        if (!this.used.has(id)) {
          this.scene.remove(mesh);
          // If procedural fallback mesh, dispose geometry and materials
          if (mesh.userData?.isProcedural) {
            disposeHierarchy(mesh);
          }
          this.pool.delete(id);
        }
      }
    }
  }
}

function disposeHierarchy(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        for (const m of child.material) m.dispose();
      } else if (child.material) {
        child.material.dispose();
      }
    }
  });
}
