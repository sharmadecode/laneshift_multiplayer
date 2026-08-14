import * as THREE from 'three';
import { PLAYER_MAX_SPEED, STEER_ROLL, STEER_YAW } from '@hr/shared';
import { createVehicle, stepPlayer, type InputState, type VehicleState } from '@hr/simulation';
import { createCarMesh } from './CarMesh';
import { assetLoader } from './AssetLoader';

interface TireSmokeParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

export class Player {
  readonly state: VehicleState = createVehicle();
  readonly mesh: THREE.Group;
  private carVisual: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  readonly headlight: THREE.SpotLight;

  private camPos = new THREE.Vector3(0, 4.4, 8.2);
  private fov = 58;
  private baseFov = 58;
  private shake = 0;
  private smokeParticles: TireSmokeParticle[] = [];
  private smokeMesh: THREE.InstancedMesh;
  private smokeMat: THREE.MeshBasicMaterial;
  private smokeMatrix = new THREE.Matrix4();

  constructor(private scene: THREE.Scene) {
    this.mesh = new THREE.Group();
    const fallback = createCarMesh({ color: 0xe74c3c, isPlayer: true, type: 'hero_gt' });
    this.mesh.add(fallback);
    this.carVisual = fallback;
    scene.add(this.mesh);

    assetLoader.onReady(() => {
      const glbCar = assetLoader.createHeroCarInstance(0xe74c3c);
      if (glbCar) {
        this.mesh.remove(this.carVisual);
        this.carVisual = glbCar;
        this.mesh.add(glbCar);
      }
    });

    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 1400);
    this.camera.position.copy(this.camPos);

    this.headlight = new THREE.SpotLight(0xfffae6, 25, 60, 0.5, 0.6, 1.2);
    this.headlight.position.set(0, 0.9, -1.8);
    this.headlight.target.position.set(0, 0, -40);
    this.mesh.add(this.headlight);
    this.mesh.add(this.headlight.target);

    // --- Lightweight GPU Instanced Tire Smoke System ---
    const smokeGeo = new THREE.PlaneGeometry(1, 1);
    this.smokeMat = new THREE.MeshBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.45,
      depthWrite: false
    });
    this.smokeMesh = new THREE.InstancedMesh(smokeGeo, this.smokeMat, 40);
    this.smokeMesh.count = 0;
    this.smokeMesh.renderOrder = 5;
    scene.add(this.smokeMesh);
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
      m.rotation.x += 1.8 * dt;
      this.shake = 1;
    } else {
      const f = rs / PLAYER_MAX_SPEED;
      // Real suspension pitch: dives front on brake, squats rear on throttle
      m.rotation.x = THREE.MathUtils.lerp(m.rotation.x, s.pitch, 14 * dt);
      // Real chassis roll: combines lateral G suspension roll with steering weight transfer
      const targetRoll = s.roll - rSteer * STEER_ROLL * (0.35 + 0.65 * f);
      m.rotation.z = THREE.MathUtils.lerp(m.rotation.z, targetRoll, 14 * dt);
      m.rotation.y = THREE.MathUtils.lerp(m.rotation.y, -rSteer * STEER_YAW * (0.3 + 0.7 * f), 12 * dt);
    }

    // Wheel spin & active steering yaw on front wheels
    const spin = (rs * dt) / 0.34;
    const wheels = (this.carVisual.userData.wheels ?? m.userData.wheels ?? []) as THREE.Object3D[];
    for (const w of wheels) {
      if (w && w.rotation) {
        w.rotation.x -= spin;
        // Active steering turn on front wheels (named wheel_fl, wheel_fr or located in front)
        const name = (w.name || '').toLowerCase();
        if (name.includes('fl') || name.includes('fr') || name.includes('front') || w.position.z < -0.5) {
          w.rotation.y = THREE.MathUtils.lerp(w.rotation.y, -rSteer * 0.42, 16 * dt);
        }
      }
    }

    // --- Dynamic Tire Smoke on High Lateral G or Braking ---
    if (rs > 15 && (Math.abs(s.lateralG) > 0.65 || (s.pitch > 0.015 && rs > 25))) {
      this.spawnTireSmoke(rx, rs);
    }
    this.updateTireSmoke(dt);

    // --- Dynamic Spring-Damper Chase Camera ---
    const speedRatio = rs / PLAYER_MAX_SPEED;
    // Camera pulls back and lowers slightly as speed increases
    const targetY = 4.2 - speedRatio * 0.5 + s.pitch * 6;
    const targetZ = 7.8 + speedRatio * 1.8;
    const target = new THREE.Vector3(rx * 0.78 + s.lateralG * 0.4, targetY, targetZ);
    const k = 1 - Math.pow(0.0004, dt);
    this.camPos.lerp(target, k);

    // High-speed road vibration & crash shake
    const roadVibration = rs > 35 ? (rs / PLAYER_MAX_SPEED) * 0.018 : 0;
    const sh = this.shake * this.shake * 0.9 + roadVibration;
    this.camera.position.set(
      this.camPos.x + (Math.random() - 0.5) * sh * 0.6,
      this.camPos.y + (Math.random() - 0.5) * sh * 0.5,
      this.camPos.z + (Math.random() - 0.5) * sh * 0.3
    );
    this.shake = Math.max(0, this.shake - dt * 2.2);

    // Dynamic camera look-ahead with G-force offset
    this.camera.lookAt(rx * 0.7 + s.lateralG * 0.8, 1.35, -45);

    // Dynamic speed zoom FOV
    const targetFov = this.baseFov + speedRatio * 18;
    if (Math.abs(this.fov - targetFov) > 0.05) {
      this.fov = THREE.MathUtils.lerp(this.fov, targetFov, 5 * dt);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private spawnTireSmoke(carX: number, speed: number): void {
    if (this.smokeParticles.length >= 35) return;
    for (const offset of [-0.85, 0.85]) {
      if (Math.random() < 0.45) {
        this.smokeParticles.push({
          pos: new THREE.Vector3(carX + offset + (Math.random() - 0.5) * 0.2, 0.15, 1.4 + Math.random() * 0.3),
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.4 + Math.random() * 0.6, 2.0 + speed * 0.05),
          life: 0,
          maxLife: 0.35 + Math.random() * 0.25,
          size: 0.4 + Math.random() * 0.3
        });
      }
    }
  }

  private updateTireSmoke(dt: number): void {
    for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
      const p = this.smokeParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.smokeParticles.splice(i, 1);
        continue;
      }
      p.pos.addScaledVector(p.vel, dt);
      p.size += dt * 1.8;
    }

    const count = this.smokeParticles.length;
    this.smokeMesh.count = count;
    for (let i = 0; i < count; i++) {
      const p = this.smokeParticles[i];
      const progress = p.life / p.maxLife;
      const s = p.size;
      this.smokeMatrix.makeScale(s, s, s);
      this.smokeMatrix.setPosition(p.pos.x, p.pos.y, p.pos.z);
      this.smokeMesh.setMatrixAt(i, this.smokeMatrix);
    }
    if (count > 0) this.smokeMesh.instanceMatrix.needsUpdate = true;
  }

  addShake(): void {
    this.shake = 1;
  }

  respawnVisual(): void {
    this.mesh.rotation.set(0, 0, 0);
    this.shake = 0;
    this.smokeParticles = [];
    this.smokeMesh.count = 0;
  }

  reset(): void {
    Object.assign(this.state, createVehicle());
    this.respawnVisual();
  }
}
