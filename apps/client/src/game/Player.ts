import * as THREE from 'three';
import {
  CAR_LENGTH,
  CAR_WIDTH,
  PLAYER_MAX_SPEED,
  STEER_ROLL,
  STEER_YAW,
  getTrackCurvature,
  getCurveOffset
} from '@hr/shared';
import { createVehicle, stepPlayer, type InputState, type VehicleState } from '@hr/simulation';
import { createCarMesh } from './CarMesh';
import { assetLoader } from './AssetLoader';

interface TireSmokeParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  rotSpeed: number;
}

export class Player {
  readonly state: VehicleState = createVehicle();
  readonly mesh: THREE.Group;
  private carVisual: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  readonly headlight: THREE.SpotLight;

  private camPos = new THREE.Vector3(0, 3.1, 7.2);
  private fov = 56;
  private baseFov = 56;
  private shake = 0;
  private lookTarget = new THREE.Vector3(0, 1.4, -60);
  private smokeParticles: TireSmokeParticle[] = [];
  private smokeMesh: THREE.InstancedMesh;
  private smokeMat: THREE.MeshBasicMaterial;
  private smokeMatrix = new THREE.Matrix4();
  private speedStreakMesh: THREE.InstancedMesh;
  private streaks: { x: number; y: number; z: number; len: number; speed: number }[] = [];

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

    // --- Anime Action Speed Streaks ---
    const streakGeo = new THREE.CylinderGeometry(0.015, 0.015, 1, 4);
    streakGeo.rotateX(Math.PI / 2);
    const streakMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.speedStreakMesh = new THREE.InstancedMesh(streakGeo, streakMat, 24);
    this.speedStreakMesh.count = 0;
    this.speedStreakMesh.renderOrder = 8;
    this.camera.add(this.speedStreakMesh);
    scene.add(this.camera);

    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const radius = 3.2 + Math.random() * 2.8;
      this.streaks.push({
        x: Math.cos(angle) * radius * 1.5,
        y: Math.sin(angle) * radius * 0.9,
        z: -10 - Math.random() * 25,
        len: 4 + Math.random() * 5,
        speed: 45 + Math.random() * 35
      });
    }

    // --- Soft Volumetric Tire Smoke System ---
    const smokeCv = document.createElement('canvas');
    smokeCv.width = smokeCv.height = 128;
    const sCtx = smokeCv.getContext('2d')!;
    const grad = sCtx.createRadialGradient(64, 64, 6, 64, 64, 64);
    grad.addColorStop(0, 'rgba(240, 244, 252, 0.65)');
    grad.addColorStop(0.3, 'rgba(225, 233, 245, 0.38)');
    grad.addColorStop(0.6, 'rgba(210, 220, 235, 0.15)');
    grad.addColorStop(0.85, 'rgba(195, 208, 225, 0.04)');
    grad.addColorStop(1.0, 'rgba(180, 195, 215, 0.0)');
    sCtx.fillStyle = grad;
    sCtx.fillRect(0, 0, 128, 128);

    const smokeTex = new THREE.CanvasTexture(smokeCv);
    const smokeGeo = new THREE.PlaneGeometry(1, 1);
    this.smokeMat = new THREE.MeshBasicMaterial({
      map: smokeTex,
      transparent: true,
      opacity: 0.8,
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
      const motionGrip = Math.min(1.0, Math.max(0, rs / 5.0));
      const currentCurve = getTrackCurvature(s.distance);
      // Grounded sports car suspension: tight body roll + curve lean keeps car glued to asphalt
      m.rotation.x = THREE.MathUtils.lerp(m.rotation.x, s.pitch * 0.35, 16 * dt);
      const targetRoll = (-rSteer * STEER_ROLL * (0.4 + 0.6 * f) + s.roll * 0.15 - currentCurve * 0.045) * motionGrip;
      m.rotation.z = THREE.MathUtils.lerp(m.rotation.z, targetRoll, 18 * dt);
      m.rotation.y = THREE.MathUtils.lerp(m.rotation.y, (-rSteer * STEER_YAW * (0.4 + 0.6 * f) - currentCurve * 0.04) * motionGrip, 16 * dt);
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

    // --- Elevated, Comfortable Racing Chase Camera ---
    const speedRatio = rs / PLAYER_MAX_SPEED;

    // Elevated eye-level sports car view: gives clear road vision while framing the car comfortably
    const camHeight = 3.1 - speedRatio * 0.25;
    const camDist = 7.2 + speedRatio * 0.9;
    const lookHeight = 1.4;
    const lookAhead = -60;

    // Tight horizontal tracking: car stays solidly centered with subtle steering lean
    const targetX = rx * 0.96;
    const targetY = camHeight + s.pitch * 0.8;
    const targetZ = camDist;
    const target = new THREE.Vector3(targetX, targetY, targetZ);

    // Fast, responsive damping (eliminates unanchored floaty feel)
    const k = 1 - Math.pow(0.0001, dt);
    this.camPos.lerp(target, k);

    // Impact crash shake (only active during crash impacts, zero noise during normal driving)
    if (this.shake > 0.01) {
      const sh = this.shake * this.shake * 0.8;
      this.camera.position.set(
        this.camPos.x + (Math.random() - 0.5) * sh * 0.4,
        this.camPos.y + (Math.random() - 0.5) * sh * 0.35,
        this.camPos.z + (Math.random() - 0.5) * sh * 0.2
      );
      this.shake = Math.max(0, this.shake - dt * 2.5);
    } else {
      this.camera.position.copy(this.camPos);
      this.shake = 0;
    }

    // Smoothly damped apex look-ahead camera tracking
    const apexOffset = getCurveOffset(s.distance, 50);
    const targetLookX = rx * 0.9 + apexOffset * 0.72 - rSteer * 0.35;
    this.lookTarget.x = THREE.MathUtils.lerp(this.lookTarget.x, targetLookX, 12 * dt);
    this.camera.lookAt(this.lookTarget.x, lookHeight, lookAhead);

    // Smooth speed FOV transition (56 deg -> 68 deg)
    const targetFov = this.baseFov + speedRatio * 12;
    if (Math.abs(this.fov - targetFov) > 0.05) {
      this.fov = THREE.MathUtils.lerp(this.fov, targetFov, 6 * dt);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.updateSpeedStreaks(dt, speedRatio);
  }

  private updateSpeedStreaks(dt: number, speedRatio: number): void {
    if (speedRatio < 0.35) {
      this.speedStreakMesh.count = 0;
      return;
    }
    const streakIntensity = (speedRatio - 0.35) / 0.65;
    const activeCount = Math.min(24, Math.floor(24 * (0.4 + streakIntensity * 0.6)));
    this.speedStreakMesh.count = activeCount;

    const mat = new THREE.Matrix4();
    for (let i = 0; i < activeCount; i++) {
      const st = this.streaks[i];
      st.z += st.speed * dt * (1 + streakIntensity * 0.8);
      if (st.z > -1.5) {
        st.z = -22 - Math.random() * 15;
      }
      mat.makeScale(1, 1, st.len * (0.8 + streakIntensity * 0.6));
      mat.setPosition(st.x, st.y, st.z);
      this.speedStreakMesh.setMatrixAt(i, mat);
    }
    this.speedStreakMesh.instanceMatrix.needsUpdate = true;
  }

  private spawnTireSmoke(carX: number, speed: number): void {
    if (this.smokeParticles.length >= 35) return;
    for (const offset of [-0.85, 0.85]) {
      if (Math.random() < 0.5) {
        this.smokeParticles.push({
          pos: new THREE.Vector3(carX + offset + (Math.random() - 0.5) * 0.15, 0.18, 1.4 + Math.random() * 0.25),
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.7, 0.35 + Math.random() * 0.5, 1.5 + speed * 0.04),
          life: 0,
          maxLife: 0.4 + Math.random() * 0.3,
          size: 0.5 + Math.random() * 0.35,
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 4.0
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
      p.rot += p.rotSpeed * dt;
      // Air resistance slows smoke velocity
      p.vel.multiplyScalar(Math.max(0, 1 - 2.5 * dt));
    }

    const count = this.smokeParticles.length;
    this.smokeMesh.count = count;
    for (let i = 0; i < count; i++) {
      const p = this.smokeParticles[i];
      const progress = p.life / p.maxLife;
      // Soft organic expansion: starts tight, expands into voluminous cloud
      const s = p.size * (0.7 + progress * 2.8);
      this.smokeMatrix.makeRotationZ(p.rot);
      this.smokeMatrix.scale(new THREE.Vector3(s, s, s));
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
