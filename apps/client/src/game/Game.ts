import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CRASH_TIME, TICK_RATE, type InputMsg, type WorldSnapshot } from '@hr/shared';
import {
  crash,
  playerHitsTraffic,
  stepPlayer,
  TrafficSpawner,
  type InputState,
  type TrafficCar,
  type VehicleState
} from '@hr/simulation';
import { Road } from './Road';
import { Player } from './Player';
import { TrafficRenderer, TRAFFIC_COLORS } from './TrafficRenderer';
import { createCarMesh } from './CarMesh';
import { Input } from './Input';
import { Hud, type Preset } from './Hud';
import { EngineAudio } from './Audio';
import { Net } from './Net';

type Mode = 'start' | 'running' | 'paused';

// A small visual delay gives the client two authoritative snapshots to blend
// between. It removes packet-to-packet jumps without making friends feel late.
const REMOTE_DELAY_MS = 120;

interface SnapshotSample {
  prev: WorldSnapshot;
  next: WorldSnapshot;
  t: number;
}

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
  private density = PRESETS.medium.density;
  private mode: Mode = 'start';
  private audio = new EngineAudio();
  private fpsEl: HTMLElement | null = null;
  private fpsFrames = 0;
  private fpsTime = 0;

  // --- multiplayer ---
  private online = false;
  private net: Net | null = null;
  private remotes = new Map<string, THREE.Group>();
  private snapHistory: WorldSnapshot[] = [];
  /** Maps the server's Date.now clock into this client's Date.now clock. */
  private serverClockOffsetMs: number | null = null;
  private serverCrashed = false;
  /** A locally-detected crash awaiting server confirmation (do not un-crash yet). */
  private localCrashPending = false;

  // --- client prediction: local car stepped on the server's 30 Hz grid ---
  /** Input most recently ACCEPTED by the network layer (what the server has). */
  private latestSentInput: InputState | null = null;
  private gridStepMs = 1000 / TICK_RATE;
  private gridAccum = 0;
  private prevGrid: VehicleState | null = null;
  private pendingInputs: InputMsg[] = [];
  // Reconciliation changes the hidden prediction state immediately, but the
  // renderer eases that correction over a few frames so the road never yanks.
  private visualCorrection = { x: 0, speed: 0, distance: 0, steering: 0 };

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
    this.traffic = new TrafficRenderer(this.scene);

    this.hud = new Hud(container, {
      onPreset: (p) => this.applyPreset(p),
      onAutoThrottle: (b) => (this.input.autoThrottle = b),
      onSensitivity: (n) => (this.input.sensitivity = n),
      onSound: (b) => this.audio.setMuted(!b),
      onStart: () => this.beginRun(),
      onPauseToggle: () => this.togglePause(),
      onRestart: () => this.restart()
    });

    this.input = new Input(this.hud.steerLeftBtn, this.hud.steerRightBtn, this.hud.brakeBtn, this.hud.throttleBtn, {
      onSteerVisual: () => undefined
    });
    this.input.autoThrottle = this.hud.autoThrottle;
    this.input.sensitivity = this.hud.sensitivity;

    this.connectNet();

    window.addEventListener('keydown', (e) => {
      if ((e.code === 'KeyP' || e.code === 'Escape') && this.mode !== 'start') {
        this.togglePause();
      } else if (this.mode === 'start' && !e.repeat) {
        this.beginRun();
      }
    });

    if (new URLSearchParams(location.search).has('fps')) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'fps-counter';
      container.appendChild(this.fpsEl);
    }

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
    if (this.mode === 'running') this.update(dt);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.player.camera);
    this.tickFps(dt);
  }

  private beginRun(): void {
    this.audio.init();
    this.audio.setMuted(!this.hud.sound);
    this.hud.startGame();
    this.mode = 'running';
  }

  private togglePause(): void {
    if (this.mode === 'running') {
      this.mode = 'paused';
      this.audio.suspend();
      this.net?.sendInput({ steering: 0, throttle: 0, brake: 1 });
      this.hud.setPaused(true);
    } else if (this.mode === 'paused') {
      this.mode = 'running';
      this.audio.resume();
      this.hud.setPaused(false);
    }
  }

  private restart(): void {
    this.player.reset();
    if (!this.online) this.spawner.reset(this.density);
    for (const b of this.bursts) {
      this.scene.remove(b.points);
      b.points.geometry.dispose();
      (b.points.material as THREE.Material).dispose();
    }
    this.bursts = [];
    this.wasCrashed = false;
    this.hud.resetRun();
    this.hud.setPaused(false);
    this.mode = 'running';
    this.audio.resume();
  }

  private tickFps(dt: number): void {
    if (!this.fpsEl) return;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      const fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsEl.textContent = `${fps} fps`;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
  }

  private update(dt: number): void {
    const input = this.input.read();
    const s = this.player.state;

    if (this.online && this.net) {
      const sent = this.net.sendInput({ steering: input.steering, throttle: input.throttle, brake: input.brake });
      if (sent) {
        this.latestSentInput = sent;
        this.pendingInputs.push(sent);
        // A disconnected tab can otherwise retain an unbounded prediction queue.
        if (this.pendingInputs.length > 90) this.pendingInputs.shift();
      }

      // Step the local car on the server's 30 Hz tick grid, applying the input
      // the server actually has. Never an input that was only read locally —
      // the server trajectory is then exactly ours delayed by latency.
      this.gridAccum += dt * 1000;
      while (this.gridAccum >= this.gridStepMs) {
        this.gridAccum -= this.gridStepMs;
        this.prevGrid = { ...s };
        stepPlayer(s, this.latestSentInput ?? input, 1 / TICK_RATE);
      }

      // Interpolate between the last two grid states for smooth 60 fps motion.
      const r = this.predictedRenderState();
      // Large corrections (for example, after a backgrounded tab) should be
      // imperceptible camera/road drift, never a visible one-frame snap.
      const correctionKeep = Math.exp(-2 * dt);
      this.visualCorrection.x *= correctionKeep;
      this.visualCorrection.speed *= correctionKeep;
      this.visualCorrection.distance *= correctionKeep;
      this.visualCorrection.steering *= correctionKeep;
      r.x += this.visualCorrection.x;
      r.speed += this.visualCorrection.speed;
      r.distance += this.visualCorrection.distance;
      r.steering += this.visualCorrection.steering;

      if (this.wasCrashed && !s.crashed) {
        this.player.respawnVisual();
        this.hud.hideCrash();
      }
      this.wasCrashed = s.crashed;

      if (s.crashed) this.hud.updateCrashTimer(s.crashTimer);
      this.audio.setSpeed(r.speed);

      this.road.update(r.speed * dt);
      this.traffic.sync(this.renderTraffic(), r.distance);
      this.syncRemotes(dt);
      this.player.syncVisuals(dt, r);
      this.updateBursts(dt);
      this.hud.update({ speed: r.speed, distance: r.distance });
      return;
    }

    // ---- offline fallback ----
    this.player.update(input, dt);
    this.spawner.update(s.distance, dt);

    if (!s.crashed && !s.ghost) {
      playerHitsTraffic(s.x, this.spawner.cars, s.distance, () => this.onCrash());
    }
    if (this.wasCrashed && !s.crashed) this.onRespawn();
    this.wasCrashed = s.crashed;

    if (s.crashed) this.hud.updateCrashTimer(s.crashTimer);
    this.audio.setSpeed(s.speed);

    this.road.update(s.speed * dt);
    this.traffic.sync(this.spawner.cars, s.distance);
    this.player.syncVisuals(dt);
    this.updateBursts(dt);
    this.hud.update({ speed: s.speed, distance: s.distance });
  }

  private predictedRenderState(): Pick<VehicleState, 'x' | 'speed' | 'distance' | 'steering'> {
    const s = this.player.state;
    const u = Math.min(1, this.gridAccum / this.gridStepMs);
    return {
      x: THREE.MathUtils.lerp(this.prevGrid?.x ?? s.x, s.x, u),
      speed: THREE.MathUtils.lerp(this.prevGrid?.speed ?? s.speed, s.speed, u),
      distance: THREE.MathUtils.lerp(this.prevGrid?.distance ?? s.distance, s.distance, u),
      steering: THREE.MathUtils.lerp(this.prevGrid?.steering ?? s.steering, s.steering, u)
    };
  }

  private connectNet(): void {
    this.hud.setNet('CONNECTING\u2026', false);
    const net = new Net({
      onSnapshot: (snap) => this.onSnapshot(snap),
      onCrash: (msg) => this.onRemoteCrash(msg),
      onWelcome: () => {
        this.net = net;
        this.online = true;
        this.hud.setNet('ONLINE \u00b7 1', true);
      }
    });
    net.connect().catch(() => {
      this.hud.setNet('OFFLINE', false);
    });
  }

  /** Server snapshot: background confirmation; only corrects real divergences. */
  private onSnapshot(snap: WorldSnapshot): void {
    const measuredOffset = Date.now() - snap.ts;
    this.serverClockOffsetMs = this.serverClockOffsetMs === null
      ? measuredOffset
      : THREE.MathUtils.lerp(this.serverClockOffsetMs, measuredOffset, 0.1);

    this.snapHistory.push(snap);
    if (this.snapHistory.length > 40) this.snapHistory.shift();
    this.hud.setNet(`ONLINE \u00b7 ${snap.players.length}`, true);
    // Anchor send cadence to snapshot arrival: ~1 input per server tick.
    this.net?.resync(performance.now());

    const me = snap.players.find((p) => p.id === this.net?.playerId);
    if (!me) return;

    const s = this.player.state;

    // Motion reconciliation: only a real divergence (dropped frames / tab
    // hidden / input collapse) puts us far from the server's view. Crash and
    // ghost flags are authoritative and applied separately below.
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > me.appliedSeq);
    const needsReconcile =
      // One server tick plus normal network latency is expected prediction
      // lead, not an error worth visibly correcting.
      Math.abs(s.x - me.x) > 1.25 ||
      Math.abs(s.speed - me.speed) > 5 ||
      Math.abs(s.distance - me.distance) > 7;

    if (needsReconcile) {
      // Preserve the exact screen position, which may be between two fixed
      // simulation steps. Preserving only `s` causes a one-tick visual jump.
      const oldVisualState = this.predictedRenderState();
      s.x = me.x;
      s.speed = me.speed;
      s.distance = me.distance;
      s.steering = me.steering;

      for (const input of this.pendingInputs) stepPlayer(s, input, 1 / TICK_RATE);
      this.prevGrid = { ...s };
      this.gridAccum = 0;
      this.visualCorrection.x += oldVisualState.x - s.x;
      this.visualCorrection.speed += oldVisualState.speed - s.speed;
      this.visualCorrection.distance += oldVisualState.distance - s.distance;
      this.visualCorrection.steering += oldVisualState.steering - s.steering;
    }

    // Authoritative flags apply immediately (crash, respawn, ghost).
    // ghostTimer is left to the local sim: both sides decrement it identically.
    // A crash detected locally (client is ~RTT ahead) must not be un-crashed
    // until the server has confirmed it, or the crash flickers on and off.
    if (me.crashed) {
      s.crashed = true;
      s.crashTimer = me.crashTimer;
      this.localCrashPending = false;
    } else if (!this.localCrashPending) {
      s.crashed = false;
    }
    s.ghost = me.ghost;
    if (!s.crashed && !s.ghost) s.ghostTimer = 0;

    // Re-anchor the grid phase to the server tick schedule so steps keep
    // landing on the same boundaries as the server's.
    this.gridAccum %= this.gridStepMs;

    if (me.crashed && !this.serverCrashed) this.onRemoteCrash({ playerId: me.id, x: me.x });
    this.serverCrashed = me.crashed;

    this.ensureRemoteMeshes(snap);
  }

  /**
   * Traffic arrives at 20 Hz; interpolate between the last two snapshots so it
   * moves smoothly relative to the (60 fps) player instead of stuttering.
   */
  private sampleSnapshots(delayMs = REMOTE_DELAY_MS): SnapshotSample | null {
    const history = this.snapHistory;
    if (!history.length || this.serverClockOffsetMs === null) return null;
    const renderTs = Date.now() - this.serverClockOffsetMs - delayMs;

    if (renderTs <= history[0].ts) return { prev: history[0], next: history[0], t: 0 };
    for (let i = history.length - 1; i > 0; i--) {
      const prev = history[i - 1];
      const next = history[i];
      if (prev.ts <= renderTs && renderTs <= next.ts) {
        return {
          prev,
          next,
          t: THREE.MathUtils.clamp((renderTs - prev.ts) / Math.max(1, next.ts - prev.ts), 0, 1)
        };
      }
    }
    const last = history[history.length - 1];
    return { prev: last, next: last, t: 0 };
  }

  private renderTraffic(): TrafficCar[] {
    const sample = this.sampleSnapshots();
    if (!sample) return [];
    const { prev, next, t } = sample;
    const prevById = new Map<number, TrafficCar>();
    for (const c of prev.traffic) prevById.set(c.id, c);
    const out: TrafficCar[] = new Array(next.traffic.length);
    for (let i = 0; i < next.traffic.length; i++) {
      const c = next.traffic[i];
      const p = prevById.get(c.id);
      if (!p) {
        out[i] = c;
        continue;
      }
      out[i] = {
        id: c.id,
        lane: c.lane,
        x: p.x + (c.x - p.x) * t,
        roadDist: p.roadDist + (c.roadDist - p.roadDist) * t,
        speed: p.speed + (c.speed - p.speed) * t,
        length: c.length,
        width: c.width,
        modelIndex: c.modelIndex,
        colorIndex: c.colorIndex
      };
    }
    return out;
  }

  private onRemoteCrash(msg: { playerId: string; x: number }): void {
    if (msg.playerId === this.net?.playerId) {
      if (!this.player.state.crashed) {
        crash(this.player.state);
        this.player.addShake();
        this.audio.crash();
        this.hud.showCrash(this.player.state.crashTimer);
      }
    } else {
      this.audio.crash();
    }
    this.spawnBurstAt(msg.x, 0);
  }

  private ensureRemoteMeshes(snap: WorldSnapshot): void {
    const mine = this.net?.playerId;
    const ids = new Set(snap.players.map((p) => p.id));
    for (const [id, mesh] of this.remotes) {
      if (id === mine || !ids.has(id)) {
        this.scene.remove(mesh);
        this.remotes.delete(id);
      }
    }
    for (const p of snap.players) {
      if (p.id === mine || this.remotes.has(p.id)) continue;
      const color = TRAFFIC_COLORS[hashId(p.id) % TRAFFIC_COLORS.length];
      const mesh = createCarMesh({ color });
      mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = true;
      });
      this.scene.add(mesh);
      mesh.position.set(p.x, 0, this.player.state.distance - p.distance);
      this.remotes.set(p.id, mesh);
    }
  }

  private syncRemotes(dt: number): void {
    const sample = this.sampleSnapshots();
    if (!sample) return;
    for (const [id, mesh] of this.remotes) {
      const pos = this.interpPlayer(id, sample);
      if (!pos) continue;
      // The target is already interpolation-smoothed. Applying it equally on
      // both axes prevents the sideways rubber-band caused by smoothing x
      // while snapping z.
      mesh.position.x = pos.x;
      mesh.position.z = this.player.state.distance - pos.dist;
    }
  }

  private interpPlayer(id: string, sample: SnapshotSample): { x: number; dist: number } | null {
    const a = sample.prev.players.find((p) => p.id === id);
    const b = sample.next.players.find((p) => p.id === id);
    if (!a || !b) return null;
    return {
      x: THREE.MathUtils.lerp(a.x, b.x, sample.t),
      dist: THREE.MathUtils.lerp(a.distance, b.distance, sample.t)
    };
  }

  private onCrash(): void {
    this.localCrashPending = true;
    crash(this.player.state);
    this.player.addShake();
    this.audio.crash();
    this.hud.showCrash(this.player.state.crashTimer);
    this.spawnBurst();
  }

  private onRespawn(): void {
    if (!this.online) this.spawner.clearNear(this.player.state.distance, 130);
    this.player.respawnVisual();
    this.hud.hideCrash();
  }

  private spawnBurst(): void {
    this.spawnBurstAt(this.player.state.x, 0);
  }

  private spawnBurstAt(x: number, z: number): void {
    const n = 34;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = x + (Math.random() - 0.5) * 2;
      pos[i * 3 + 1] = 0.5 + Math.random() * 0.6;
      pos[i * 3 + 2] = z - 1 + (Math.random() - 0.5) * 2;
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
    this.density = cfg.density;
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

/** Stable color index for a remote player id. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
