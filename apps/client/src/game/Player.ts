import * as THREE from 'three';
import { PLAYER_MAX_SPEED, STEER_ROLL, STEER_YAW } from '@hr/shared';
import { createVehicle, stepPlayer, type InputState, type VehicleState } from '@hr/simulation';
import { createCarMesh } from './CarMesh';

export class Player {
  readonly state: VehicleState = createVehicle();
  readonly mesh: THREE.Group;
  readonly camera: THREE.PerspectiveCamera;
  readonly headlight: THREE.SpotLight;

  private camPos = new THREE.Vector3(0, 5.4, 9.2);
  private fov = 62;
  private baseFov = 62;
  private shake = 0;

  constructor(scene: THREE.Scene) {
    this.mesh = createCarMesh({ color: 0xe8362b, isPlayer: true });
    scene.add(this.mesh);

    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 1200);
    this.camera.position.copy(this.camPos);

    this.headlight = new THREE.SpotLight(0xfff2d9, 220, 140, 0.42, 0.55, 1.4);
    this.headlight.position.set(0, 1.05, -1.7);
    this.headlight.target.position.set(0, 0, -60);
    this.mesh.add(this.headlight);
    this.mesh.add(this.headlight.target);
  }

  update(input: InputState, dt: number): void {
    stepPlayer(this.state, input, dt);
  }

  /** Optional interpolated values (online mode): smooth 60 fps motion between 30 Hz grid steps. */
  syncVisuals(dt: number, r?: { x: number; speed: number; steering: number }): void {
    const s = this.state;
    const rx = r?.x ?? s.x;
    const rs = r?.speed ?? s.speed;
    const rSteer = r?.steering ?? s.steering;
    const m = this.mesh;
    m.position.x = rx;

    if (s.crashed) {
      m.rotation.z += 5.5 * dt;
      m.rotation.y += 2.2 * dt;
      this.shake = 1;
    } else {
      const f = rs / PLAYER_MAX_SPEED;
      m.rotation.z = THREE.MathUtils.lerp(m.rotation.z, -rSteer * STEER_ROLL * (0.4 + f), 12 * dt);
      m.rotation.y = THREE.MathUtils.lerp(m.rotation.y, -rSteer * STEER_YAW * f, 10 * dt);
    }

    const spin = (rs * dt) / 0.34;
    for (const w of m.userData.wheels as THREE.Object3D[]) w.rotation.x -= spin;

    // camera
    const target = new THREE.Vector3(rx * 0.82, 5.4, 9.2);
    const k = 1 - Math.pow(0.0005, dt);
    this.camPos.lerp(target, k);
    const sh = this.shake * this.shake * 0.9;
    this.camera.position.set(
      this.camPos.x + (Math.random() - 0.5) * sh * 0.6,
      this.camPos.y + (Math.random() - 0.5) * sh * 0.5,
      this.camPos.z + (Math.random() - 0.5) * sh * 0.3
    );
    this.shake = Math.max(0, this.shake - dt * 2.2);

    this.camera.lookAt(rx * 0.75, 1.4, -40);

    const targetFov = this.baseFov + (rs / PLAYER_MAX_SPEED) * 14;
    if (Math.abs(this.fov - targetFov) > 0.05) {
      this.fov = THREE.MathUtils.lerp(this.fov, targetFov, 4 * dt);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  addShake(): void {
    this.shake = 1;
  }

  respawnVisual(): void {
    this.mesh.rotation.set(0, 0, 0);
    this.shake = 0;
  }

  reset(): void {
    Object.assign(this.state, createVehicle());
    this.respawnVisual();
  }
}
