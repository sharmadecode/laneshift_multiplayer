import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CRASH_TIME } from '@hr/shared';
import { crash, playerHitsTraffic, TrafficSpawner } from '@hr/simulation';
import { Road } from './Road';
import { Player } from './Player';
import { TrafficRenderer } from './TrafficRenderer';
import { Input } from './Input';
import { Hud, type Preset } from './Hud';

interface PresetCfg {
  pixelRatio: number;
  shadows: boolean;
  density: number;
  bloom: boolean;
  far: number;
  fog: number;
  buildings: number;
  lamps: number;
}

const PRESETS: Record<Preset, PresetCfg> = {
  low: { pixelRatio: 1, shadows: false, density: 0.55, bloom: false, far: 700, fog: 0.014, buildings: 18, lamps: 18 },
  medium: { pixelRatio: Math.min(window.devicePixelRatio, 1.5), shadows: false, density: 0.8, bloom: true, far: 1000, fog: 0.011, buildings: 30, lamps: 25 },
  high: { pixelRatio: Math.min(window.devicePixelRatio, 2), shadows: true, density: 1.0, bloom: true, far: 1400, fog: 0.009, buildings: 46, lamps: 25 }
};

interface Burst {
  points: THREE.Points;
  vel: Float32Array;
  life: number;
  ttl: number;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private road: Road;
  private player: Player;
  private spawner = new TrafficSpawner({ density: 0.8, seed: 12345 });
  private traffic: TrafficRenderer;
  private input: Input;
  private hud: Hud;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private clock = new THREE.Clock();
  private bursts: Burst[] = [];
  private wasCrashed = false;
  private preset: Preset = 'medium';

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.player = new Player(this.scene);
    this.road = new Road(this.scene, {
      shadows: PRESETS[this.preset].shadows,
      buildingsPerSide: PRESETS[this.preset].buildings,
      lampsPerSide: PRESETS[this.preset].lamps
    });
    this.traffic = new TrafficRenderer(this.scene, this.spawner);

    this.hud = new Hud(container, {
      onPreset: (p) => this.applyPreset(p),
      onAutoThrottle: (b) => (this.input.autoThrottle = b),
      onSensitivity: (n) => (this.input.sensitivity = n)
    });

    this.input = new Input(this.hud.steerLeftBtn, this.hud.steerRightBtn, this.hud.brakeBtn, this.hud.throttleBtn, {
      onSteerVisual: () => undefined
    });
    this.input.autoThrottle = this.hud.autoThrottle;
    this.input.sensitivity = this.hud.sensitivity;

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.applyPreset(this.preset);
  }

  start(): void {
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.loop());
  }

  private loop(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.update(dt);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.player.camera);
  }

  private update(dt: number): void {
    const input = this.input.read();
    this.player.update(input, dt);

    const s = this.player.state;
    this.spawner.update(s.distance, dt);

    if (!s.crashed && !s.ghost) {
      playerHitsTraffic(s.x, this.spawner.cars, s.distance, () => this.onCrash());
    }
    if (this.wasCrashed && !s.crashed) this.onRespawn();
    this.wasCrashed = s.crashed;

    if (s.crashed) this.hud.updateCrashTimer(s.crashTimer);

    this.road.update(s.speed * dt);
    this.traffic.sync(s.distance);
    this.player.syncVisuals(dt);
    this.updateBursts(dt);
    this.hud.update({ speed: s.speed, distance: s.distance });
  }

  private onCrash(): void {
    crash(this.player.state);
    this.player.addShake();
    this.hud.showCrash(this.player.state.crashTimer);
    this.spawnBurst();
  }

  private onRespawn(): void {
    this.spawner.clearNear(this.player.state.distance, 130);
    this.player.respawnVisual();
    this.hud.hideCrash();
  }

  private spawnBurst(): void {
    const n = 34;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = this.player.state.x + (Math.random() - 0.5) * 2;
      pos[i * 3 + 1] = 0.5 + Math.random() * 0.6;
      pos[i * 3 + 2] = -1 + (Math.random() - 0.5) * 2;
      vel[i * 3] = (Math.random() - 0.5) * 16;
      vel[i * 3 + 1] = 4 + Math.random() * 10;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 16;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffb14d,
      size: 0.5,
      transparent: true,
      opacity: 1,
      depthWrite: false
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.bursts.push({ points, vel, life: 0.9, ttl: 0.9 });
  }

  private updateBursts(dt: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt;
      const attr = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let j = 0; j < arr.length / 3; j++) {
        arr[j * 3] += b.vel[j * 3] * dt;
        arr[j * 3 + 1] += b.vel[j * 3 + 1] * dt;
        arr[j * 3 + 2] += b.vel[j * 3 + 2] * dt;
        b.vel[j * 3 + 1] -= 9.8 * dt;
      }
      attr.needsUpdate = true;
      (b.points.material as THREE.PointsMaterial).opacity = Math.max(0, b.life / b.ttl);
      if (b.life <= 0) {
        this.scene.remove(b.points);
        b.points.geometry.dispose();
        (b.points.material as THREE.Material).dispose();
        this.bursts.splice(i, 1);
      }
    }
  }

  private applyPreset(preset: Preset): void {
    this.preset = preset;
    const cfg = PRESETS[preset];
    this.renderer.setPixelRatio(cfg.pixelRatio);
    this.renderer.shadowMap.enabled = cfg.shadows;
    this.road.setShadows(cfg.shadows);
    this.spawner.reset(cfg.density);

    const fog = this.scene.fog as THREE.FogExp2;
    fog.density = cfg.fog;
    this.player.camera.far = cfg.far;
    this.player.camera.updateProjectionMatrix();

    if (cfg.bloom && !this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.player.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.55,
        0.6,
        0.75
      );
      this.composer.addPass(this.bloomPass);
    } else if (!cfg.bloom && this.composer) {
      this.composer.dispose();
      this.composer = null;
      this.bloomPass = null;
    }
    this.resize();
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.player.camera.aspect = w / h;
    this.player.camera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(w, h);
  }
}
