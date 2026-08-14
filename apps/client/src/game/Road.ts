import * as THREE from 'three';
import { LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH } from '@hr/shared';
import { assetLoader } from './AssetLoader';

const ROAD_HALF = ROAD_HALF_WIDTH;
const TILE_LEN = 100; // exact integer tile length for zero-jitter wrapping (m)
const GROUND_LEN = 1600; // ground plane depth (16 exact tiles)
const GROUND_CENTER = (8 - (GROUND_LEN - 8)) / 2;
const SCENERY_BACK = 60; // recycle objects when they pass this z
const SCENERY_PERIOD = 2000; // 5 rich biomes x 400m each

export type WeatherState = 'day' | 'sunset' | 'night' | 'rain';
export type WeatherPreset = 'dynamic' | WeatherState;

export interface RoadOptions {
  shadows: boolean;
  buildingsPerSide: number;
  lampsPerSide: number;
}

interface SceneryProp {
  obj: THREE.Object3D;
  initZ: number;
  period: number;
}

interface WeatherConfig {
  topColor: THREE.Color;
  midColor: THREE.Color;
  horizonColor: THREE.Color;
  sunColor: THREE.Color;
  sunDir: THREE.Vector3;
  starIntensity: number;
  fogColor: THREE.Color;
  fogDensity: number;
  sunLightColor: THREE.Color;
  sunIntensity: number;
  hemiColor: THREE.Color;
  hemiGroundColor: THREE.Color;
  hemiIntensity: number;
  asphaltRoughness: number;
  asphaltMetalness: number;
  sidewalkRoughness: number;
  rainAlpha: number;
}

const WEATHER_PRESETS: Record<WeatherState, WeatherConfig> = {
  day: {
    topColor: new THREE.Color(0x0284c7),
    midColor: new THREE.Color(0x38bdf8),
    horizonColor: new THREE.Color(0xfef08a),
    sunColor: new THREE.Color(0xfffbeb),
    sunDir: new THREE.Vector3(0.52, 0.76, -0.32).normalize(),
    starIntensity: 0.0,
    fogColor: new THREE.Color(0xb8e2ff),
    fogDensity: 0.0018,
    sunLightColor: new THREE.Color(0xfffbeb),
    sunIntensity: 1.85,
    hemiColor: new THREE.Color(0x38bdf8),
    hemiGroundColor: new THREE.Color(0x22c55e),
    hemiIntensity: 1.15,
    asphaltRoughness: 0.45,
    asphaltMetalness: 0.1,
    sidewalkRoughness: 0.8,
    rainAlpha: 0.0
  },
  sunset: {
    topColor: new THREE.Color(0x31103f),
    midColor: new THREE.Color(0xdb2777),
    horizonColor: new THREE.Color(0xfbbf24),
    sunColor: new THREE.Color(0xfef08a),
    sunDir: new THREE.Vector3(0.75, 0.25, -0.4).normalize(),
    starIntensity: 0.0,
    fogColor: new THREE.Color(0xf472b6),
    fogDensity: 0.0022,
    sunLightColor: new THREE.Color(0xfb923c),
    sunIntensity: 1.45,
    hemiColor: new THREE.Color(0xf472b6),
    hemiGroundColor: new THREE.Color(0x78350f),
    hemiIntensity: 0.85,
    asphaltRoughness: 0.45,
    asphaltMetalness: 0.1,
    sidewalkRoughness: 0.75,
    rainAlpha: 0.0
  },
  night: {
    topColor: new THREE.Color(0x01040a),
    midColor: new THREE.Color(0x0a0f24),
    horizonColor: new THREE.Color(0x0f172a),
    sunColor: new THREE.Color(0xc7d2fe),
    sunDir: new THREE.Vector3(-0.4, 0.85, -0.3).normalize(),
    starIntensity: 1.4,
    fogColor: new THREE.Color(0x030712),
    fogDensity: 0.0058,
    sunLightColor: new THREE.Color(0x4338ca),
    sunIntensity: 0.28,
    hemiColor: new THREE.Color(0x1e1b4b),
    hemiGroundColor: new THREE.Color(0x020617),
    hemiIntensity: 0.22,
    asphaltRoughness: 0.35,
    asphaltMetalness: 0.15,
    sidewalkRoughness: 0.6,
    rainAlpha: 0.0
  },
  rain: {
    topColor: new THREE.Color(0x1e293b),
    midColor: new THREE.Color(0x475569),
    horizonColor: new THREE.Color(0x64748b),
    sunColor: new THREE.Color(0x94a3b8),
    sunDir: new THREE.Vector3(0.3, 0.9, -0.2).normalize(),
    starIntensity: 0.0,
    fogColor: new THREE.Color(0x334155),
    fogDensity: 0.0035,
    sunLightColor: new THREE.Color(0x94a3b8),
    sunIntensity: 0.75,
    hemiColor: new THREE.Color(0x334155),
    hemiGroundColor: new THREE.Color(0x1e293b),
    hemiIntensity: 0.65,
    asphaltRoughness: 0.15,
    asphaltMetalness: 0.35,
    sidewalkRoughness: 0.3,
    rainAlpha: 0.75
  }
};

import { getRandomWeatherForPhase, type WeatherType } from '@hr/simulation';

const WEATHER_INTERVAL = 3000; // 3km per weather phase

export class Road {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private groundTex!: THREE.CanvasTexture;
  private sidewalkTex!: THREE.CanvasTexture;
  private grassTex!: THREE.CanvasTexture;
  private scrollers: FastScroller[] = [];
  private sceneryProps: SceneryProp[] = [];
  private dynamicSceneryGroup = new THREE.Group();
  private skyDome!: THREE.Mesh;
  private skyMat!: THREE.ShaderMaterial;
  private rainPoints: THREE.Points | null = null;
  private rainGeo: THREE.BufferGeometry | null = null;
  private sceneRef: THREE.Scene;
  private asphaltMat!: THREE.MeshStandardMaterial;
  private sidewalkMat!: THREE.MeshStandardMaterial;
  private trainGroup: THREE.Group | null = null;
  private cloudsGroup = new THREE.Group();
  private cloudLayers: { mesh: THREE.Object3D; speedX: number; speedZ: number }[] = [];

  private buildSkyDome(scene: THREE.Scene): void {
    const domeGeo = new THREE.SphereGeometry(1, 48, 24);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x0284c7) },
        midColor: { value: new THREE.Color(0x38bdf8) },
        horizonColor: { value: new THREE.Color(0xfef08a) },
        sunColor: { value: new THREE.Color(0xfffbeb) },
        sunDir: { value: new THREE.Vector3(0.52, 0.76, -0.32).normalize() },
        starIntensity: { value: 0.0 }
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        uniform vec3 sunColor;
        uniform vec3 sunDir;
        uniform float starIntensity;
        varying vec3 vDir;
        
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        void main() {
          float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
          
          vec3 sky;
          if (h < 0.45) {
            float t = h / 0.45;
            sky = mix(horizonColor, midColor, smoothstep(0.0, 1.0, t));
          } else {
            float t = (h - 0.45) / 0.55;
            sky = mix(midColor, topColor, smoothstep(0.0, 1.0, t));
          }
          
          float s = max(dot(vDir, sunDir), 0.0);
          float sunDisc = smoothstep(0.994, 0.997, s) * 3.5;
          float sunGlow = pow(s, 24.0) * 0.45 + pow(s, 4.0) * 0.18;
          float sunRing = smoothstep(0.985, 0.988, s) * (1.0 - smoothstep(0.988, 0.993, s)) * 0.6;
          sky += sunColor * (sunDisc + sunGlow + sunRing);
          
          if (starIntensity > 0.01 && vDir.y > 0.04) {
            vec3 grid = floor(vDir * 200.0);
            float n = hash(grid);
            if (n > 0.982) {
              float starBright = pow((n - 0.982) / 0.018, 2.0);
              sky += vec3(0.9, 0.95, 1.0) * starBright * starIntensity * 1.8;
            }
          }
          gl_FragColor = vec4(sky, 1.0);
        }
      `
    });
    this.skyDome = new THREE.Mesh(domeGeo, this.skyMat);
    this.skyDome.scale.setScalar(900);
    this.skyDome.renderOrder = -10;
    scene.add(this.skyDome);
  }

  setFar(far: number): void {
    if (this.skyDome) this.skyDome.scale.setScalar(Math.max(300, far * 0.92));
  }

  setShadows(on: boolean, mapSize = 2048): void {
    this.sun.castShadow = on;
    this.sun.shadow.mapSize.set(on ? mapSize : 512, on ? mapSize : 512);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.camera.left = -130;
    this.sun.shadow.camera.right = 130;
    this.sun.shadow.camera.top = 130;
    this.sun.shadow.camera.bottom = -130;
    this.sun.shadow.bias = -0.0005;
  }

  constructor(scene: THREE.Scene, opts: RoadOptions) {
    this.sceneRef = scene;
    const horizonColor = 0xb8e2ff;
    scene.background = new THREE.Color(horizonColor);
    scene.fog = new THREE.FogExp2(horizonColor, 0.0018);
    this.buildSkyDome(scene);

    this.hemi = new THREE.HemisphereLight(0x38bdf8, 0x22c55e, 1.15);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfffbeb, 1.85);
    this.sun.position.set(65, 95, -40);
    this.sun.castShadow = opts.shadows;
    if (opts.shadows) {
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.camera.near = 10;
      this.sun.shadow.camera.far = 420;
      this.sun.shadow.camera.left = -130;
      this.sun.shadow.camera.right = 130;
      this.sun.shadow.camera.top = 130;
      this.sun.shadow.camera.bottom = -130;
      this.sun.shadow.bias = -0.0005;
    }
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.group.add(this.buildPBRHighwaySurface());
    this.group.add(this.buildSidewalkBoulevards());
    this.group.add(this.buildLushMeadowTerrain());
    this.group.add(this.buildRoadCurbsAndGuardrails());
    this.group.add(this.buildInstancedStreetlamps());
    this.group.add(this.buildInstancedFoliage());
    this.group.add(this.dynamicSceneryGroup);
    this.group.add(this.buildDistantMountains());
    this.group.add(this.buildLayeredCumulusClouds());
    this.buildRainSystem(scene);

    scene.add(this.group);

    assetLoader.onReady(() => {
      this.populate3DScenery();
    });
  }

  private rainAlpha = 0;

  getSpeedMultiplier(): number {
    return 1.0 + (this.rainAlpha || 0) * 0.35;
  }

  isRaining(): boolean {
    return (this.rainAlpha || 0) > 0.05;
  }

  private buildRainSystem(scene: THREE.Scene): void {
    const count = 2800;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 55;
      pos[i * 3 + 1] = Math.random() * 32;
      pos[i * 3 + 2] = -Math.random() * 110 + 10;
    }
    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    // High quality streaked raindrop texture
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 64;
    const ctx = cv.getContext('2d')!;
    const grad = ctx.createLinearGradient(8, 0, 8, 64);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(0.3, 'rgba(186, 230, 253, 0.45)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.95)');
    ctx.fillStyle = grad;
    ctx.fillRect(6, 0, 4, 64);
    const rainTex = new THREE.CanvasTexture(cv);

    const rainMat = new THREE.PointsMaterial({
      color: 0xbae6fd,
      size: 0.75,
      map: rainTex,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.rainPoints = new THREE.Points(this.rainGeo, rainMat);
    this.rainPoints.visible = false;
    this.rainPoints.renderOrder = 10;
    scene.add(this.rainPoints);
  }

  private isDynamicWeather = true;

  setWeather(preset: WeatherPreset): void {
    if (preset === 'dynamic') {
      this.isDynamicWeather = true;
      return;
    }
    this.isDynamicWeather = false;
    this.applyWeatherConfig(WEATHER_PRESETS[preset], WEATHER_PRESETS[preset], 1.0);
  }

  private applyWeatherConfig(from: WeatherConfig, to: WeatherConfig, t: number): void {
    const u = this.skyMat.uniforms;
    u.topColor.value.copy(from.topColor).lerp(to.topColor, t);
    u.midColor.value.copy(from.midColor).lerp(to.midColor, t);
    u.horizonColor.value.copy(from.horizonColor).lerp(to.horizonColor, t);
    u.sunColor.value.copy(from.sunColor).lerp(to.sunColor, t);
    u.sunDir.value.copy(from.sunDir).lerp(to.sunDir, t).normalize();
    u.starIntensity.value = THREE.MathUtils.lerp(from.starIntensity, to.starIntensity, t);

    // Fog & Background
    const fogCol = new THREE.Color().copy(from.fogColor).lerp(to.fogColor, t);
    this.sceneRef.background = fogCol;
    if (this.sceneRef.fog) {
      this.sceneRef.fog.color.copy(fogCol);
      (this.sceneRef.fog as THREE.FogExp2).density = THREE.MathUtils.lerp(from.fogDensity, to.fogDensity, t);
    }

    // Sunlight
    this.sun.color.copy(from.sunLightColor).lerp(to.sunLightColor, t);
    this.sun.intensity = THREE.MathUtils.lerp(from.sunIntensity, to.sunIntensity, t);

    // Hemisphere Light
    this.hemi.color.copy(from.hemiColor).lerp(to.hemiColor, t);
    this.hemi.groundColor.copy(from.hemiGroundColor).lerp(to.hemiGroundColor, t);
    this.hemi.intensity = THREE.MathUtils.lerp(from.hemiIntensity, to.hemiIntensity, t);

    // Asphalt & Sidewalk PBR Materials
    this.asphaltMat.roughness = THREE.MathUtils.lerp(from.asphaltRoughness, to.asphaltRoughness, t);
    this.asphaltMat.metalness = THREE.MathUtils.lerp(from.asphaltMetalness, to.asphaltMetalness, t);
    this.sidewalkMat.roughness = THREE.MathUtils.lerp(from.sidewalkRoughness, to.sidewalkRoughness, t);

    // Rain Particles Opacity & Visibility
    const rainAlpha = THREE.MathUtils.lerp(from.rainAlpha, to.rainAlpha, t);
    this.rainAlpha = rainAlpha;
    if (this.rainPoints) {
      this.rainPoints.visible = rainAlpha > 0.02;
      (this.rainPoints.material as THREE.PointsMaterial).opacity = Math.min(1.0, rainAlpha * 0.95);
    }
  }

  private weatherSeed = Math.floor(Math.random() * 100000);

  setWeatherSeed(seed: number): void {
    this.weatherSeed = seed;
  }

  private updateDynamicWeather(playerDist: number): void {
    if (!this.isDynamicWeather) return;

    const phase = Math.floor(playerDist / WEATHER_INTERVAL);
    const currPreset = getRandomWeatherForPhase(phase, this.weatherSeed);

    const distInPhase = playerDist % WEATHER_INTERVAL;
    const TRANSITION_DIST = 260; // 260m smooth cinematic blend zone

    if (distInPhase < TRANSITION_DIST && phase > 0) {
      const prevPreset = getRandomWeatherForPhase(phase - 1, this.weatherSeed);
      const t = THREE.MathUtils.smoothstep(distInPhase / TRANSITION_DIST, 0, 1);
      this.applyWeatherConfig(WEATHER_PRESETS[prevPreset], WEATHER_PRESETS[currPreset], t);
    } else {
      this.applyWeatherConfig(WEATHER_PRESETS[currPreset], WEATHER_PRESETS[currPreset], 1.0);
    }
  }

  update(scroll: number, playerX = 0, playerDist = 0): void {
    // Dynamic smooth weather interpolation every 3km
    this.updateDynamicWeather(playerDist);

    // 1. Ultra-fast direct Float32Array matrix scroller (zero GC allocations)
    for (let i = 0; i < this.scrollers.length; i++) {
      this.scrollers[i].update(scroll);
    }

    // 2. Scroll 3D Scenery props with Active Distance Culling
    for (let i = 0; i < this.sceneryProps.length; i++) {
      const p = this.sceneryProps[i];
      p.obj.position.z += scroll;
      if (p.obj.position.z > SCENERY_BACK) {
        p.obj.position.z -= p.period;
      }
      p.obj.visible = p.obj.position.z > -360 && p.obj.position.z < 30;
    }

    // 3. Scroll parallel railway train with visibility check
    if (this.trainGroup) {
      this.trainGroup.position.z += scroll * 0.45;
      if (this.trainGroup.position.z > SCENERY_BACK + 100) {
        this.trainGroup.position.z -= SCENERY_PERIOD;
      }
      this.trainGroup.visible = this.trainGroup.position.z > -400 && this.trainGroup.position.z < 60;
    }

    // 4. Parallax drift on cloud layers
    for (let i = 0; i < this.cloudLayers.length; i++) {
      const cl = this.cloudLayers[i];
      cl.mesh.position.x += cl.speedX;
      cl.mesh.position.z += scroll * 0.15 + cl.speedZ;
      if (cl.mesh.position.z > 100) cl.mesh.position.z -= 900;
      if (cl.mesh.position.x > 300) cl.mesh.position.x -= 600;
      else if (cl.mesh.position.x < -300) cl.mesh.position.x += 600;
    }

    // 5. Zero-drift deterministic texture offset directly calculated from player distance
    this.groundTex.offset.y = (playerDist / TILE_LEN) % 1;
    this.sidewalkTex.offset.y = (playerDist / 20) % 1;
    this.grassTex.offset.y = (playerDist / 100) % 1;

    // Follow player for sun and sky lighting
    this.sun.position.x = playerX * 0.1 + 65;
    this.sun.target.position.x = playerX * 0.1;
    this.sun.target.updateMatrixWorld();

    if (this.rainPoints && this.rainGeo && this.rainPoints.visible) {
      const pos = this.rainGeo.attributes.position.array as Float32Array;
      const count = pos.length / 3;
      const fallSpeed = 1.35;
      const windDrift = 0.14;
      for (let i = 0; i < count; i++) {
        pos[i * 3] += windDrift;
        pos[i * 3 + 1] -= fallSpeed;
        pos[i * 3 + 2] += scroll * 0.2;

        if (pos[i * 3 + 1] < 0.1 || pos[i * 3 + 2] > 12) {
          pos[i * 3 + 1] = 26 + Math.random() * 8;
          pos[i * 3] = playerX + (Math.random() - 0.5) * 55;
          pos[i * 3 + 2] = -Math.random() * 110 + 5;
        }
      }
      this.rainGeo.attributes.position.needsUpdate = true;
    }
  }

  private buildPBRHighwaySurface(): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 1024;
    cv.height = 2048;
    const ctx = cv.getContext('2d')!;

    ctx.fillStyle = '#14171f';
    ctx.fillRect(0, 0, 1024, 2048);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    for (let y = 0; y < 2048; y += 4) {
      for (let x = 0; x < 1024; x += 8) {
        if ((x + y * 3) % 7 === 0) {
          ctx.fillRect(x, y, 3, 3);
        }
      }
    }

    const totalRoadWidth = ROAD_HALF * 2;
    const pxPerMeter = 1024 / totalRoadWidth;
    const midX = 512;

    const divLeftX = midX - 2.25 * pxPerMeter;
    const divRightX = midX + 2.25 * pxPerMeter;

    const shoulderLeftX = midX - 6.75 * pxPerMeter;
    const shoulderRightX = midX + 6.75 * pxPerMeter;

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(shoulderLeftX - 6, 0, 12, 2048);
    ctx.fillRect(shoulderRightX - 6, 0, 12, 2048);

    const pixelsPerTileM = 2048 / TILE_LEN;
    const dashPx = 4.0 * pixelsPerTileM;
    const gapPx = 6.0 * pixelsPerTileM;
    const periodPx = dashPx + gapPx;

    ctx.fillStyle = '#f8fafc';
    for (let y = 0; y < 2048; y += periodPx) {
      ctx.fillRect(divLeftX - 5, y, 10, dashPx);
      ctx.fillRect(divRightX - 5, y, 10, dashPx);
    }

    const studSpacingPx = 16.0 * pixelsPerTileM;
    for (let y = 0; y < 2048; y += studSpacingPx) {
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(divLeftX - 4, y, 8, 8);
      ctx.fillRect(divRightX - 4, y, 8, 8);

      ctx.fillStyle = '#ef4444';
      ctx.fillRect(shoulderLeftX - 4, y, 8, 8);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(shoulderRightX - 4, y, 8, 8);
    }

    const curbWidthPx = (ROAD_HALF - 7.2) * pxPerMeter;
    for (let y = 0; y < 2048; y += 64) {
      ctx.fillStyle = (y / 64) % 2 === 0 ? '#1f2937' : '#9ca3af';
      ctx.fillRect(0, y, curbWidthPx, 64);
      ctx.fillRect(1024 - curbWidthPx, y, curbWidthPx, 64);
    }

    this.groundTex = new THREE.CanvasTexture(cv);
    this.groundTex.wrapT = THREE.RepeatWrapping;
    this.groundTex.repeat.set(1, GROUND_LEN / TILE_LEN);

    this.asphaltMat = new THREE.MeshStandardMaterial({
      map: this.groundTex,
      roughness: 0.45,
      metalness: 0.1
    });

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF * 2, GROUND_LEN),
      this.asphaltMat
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, GROUND_CENTER);
    ground.receiveShadow = true;
    return ground;
  }

  private buildSidewalkBoulevards(): THREE.Group {
    const g = new THREE.Group();
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 256;
    const ctx = cv.getContext('2d')!;

    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2;
    for (let y = 0; y <= 256; y += 64) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
    }
    for (let x = 0; x <= 256; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 256); ctx.stroke();
    }

    this.sidewalkTex = new THREE.CanvasTexture(cv);
    this.sidewalkTex.wrapS = this.sidewalkTex.wrapT = THREE.RepeatWrapping;
    this.sidewalkTex.repeat.set(4, GROUND_LEN / 20);

    this.sidewalkMat = new THREE.MeshStandardMaterial({
      map: this.sidewalkTex,
      roughness: 0.8,
      color: 0xe2e8f0
    });

    const sideWidth = 14; 
    for (const side of [-1, 1]) {
      const walkMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(sideWidth, GROUND_LEN),
        this.sidewalkMat
      );
      walkMesh.rotation.x = -Math.PI / 2;
      walkMesh.position.set(side * (ROAD_HALF + sideWidth / 2), -0.04, GROUND_CENTER);
      walkMesh.receiveShadow = true;
      g.add(walkMesh);
    }
    return g;
  }

  private buildLushMeadowTerrain(): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 256;
    const ctx = cv.getContext('2d')!;

    ctx.fillStyle = '#2e7d32';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#388e3c';
    for (let i = 0; i < 400; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      ctx.fillRect(x, y, 3, 3);
    }

    this.grassTex = new THREE.CanvasTexture(cv);
    this.grassTex.wrapS = this.grassTex.wrapT = THREE.RepeatWrapping;
    this.grassTex.repeat.set(24, GROUND_LEN / 100);

    const mat = new THREE.MeshStandardMaterial({
      map: this.grassTex,
      roughness: 0.92,
      color: 0x4caf50
    });

    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(550, GROUND_LEN), mat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(0, -0.06, GROUND_CENTER);
    terrain.receiveShadow = true;
    return terrain;
  }

  private buildRoadCurbsAndGuardrails(): THREE.Group {
    const g = new THREE.Group();
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.75 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.85, roughness: 0.25 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.9, roughness: 0.3 });

    const segmentLen = 40;
    const count = Math.ceil(SCENERY_PERIOD / segmentLen);

    const curbMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.24, segmentLen), curbMat, count * 2);
    const railMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.42, segmentLen), railMat, count * 2);
    const postMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6), postMat, count * 8);

    let idx = 0;
    let postIdx = 0;

    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const z = -i * segmentLen - segmentLen / 2;
        const curbX = side * (ROAD_HALF + 0.22);
        const railX = side * (ROAD_HALF + 0.85);

        const mc = new THREE.Matrix4();
        mc.setPosition(curbX, 0.12, z);
        curbMesh.setMatrixAt(idx, mc);

        const mr = new THREE.Matrix4();
        mr.setPosition(railX, 0.58, z);
        railMesh.setMatrixAt(idx, mr);
        idx++;

        for (let p = 0; p < 4; p++) {
          const pz = z - segmentLen / 2 + (p / 4) * segmentLen + 5;
          const mp = new THREE.Matrix4();
          mp.setPosition(railX, 0.4, pz);
          postMesh.setMatrixAt(postIdx++, mp);
        }
      }
    }

    curbMesh.instanceMatrix.needsUpdate = true;
    railMesh.instanceMatrix.needsUpdate = true;
    postMesh.instanceMatrix.needsUpdate = true;

    curbMesh.castShadow = true;
    curbMesh.receiveShadow = true;
    railMesh.castShadow = true;
    railMesh.receiveShadow = true;

    this.scrollers.push(
      new FastScroller(curbMesh, count * 2, SCENERY_BACK, SCENERY_PERIOD),
      new FastScroller(railMesh, count * 2, SCENERY_BACK, SCENERY_PERIOD),
      new FastScroller(postMesh, postIdx, SCENERY_BACK, SCENERY_PERIOD)
    );

    g.add(curbMesh, railMesh, postMesh);
    return g;
  }

  private buildInstancedStreetlamps(): THREE.Group {
    const g = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.85, roughness: 0.3 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xfef08a,
      emissiveIntensity: 0.85,
      roughness: 0.2
    });

    const spacing = 36;
    const count = Math.floor(SCENERY_PERIOD / spacing);

    const postGeo = new THREE.CylinderGeometry(0.1, 0.16, 7.2, 6);
    const headGeo = new THREE.BoxGeometry(0.32, 0.14, 0.85);

    const postMesh = new THREE.InstancedMesh(postGeo, postMat, count * 2);
    const headMesh = new THREE.InstancedMesh(headGeo, lampMat, count * 2);

    let idx = 0;
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const z = -i * spacing - 10;
        const x = side * (ROAD_HALF + 2.2);

        const mp = new THREE.Matrix4();
        mp.setPosition(x, 3.6, z);
        postMesh.setMatrixAt(idx, mp);

        const mh = new THREE.Matrix4();
        mh.setPosition(x - side * 0.4, 7.1, z);
        headMesh.setMatrixAt(idx, mh);

        idx++;
      }
    }

    postMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;

    postMesh.castShadow = true;
    postMesh.receiveShadow = true;

    this.scrollers.push(
      new FastScroller(postMesh, count * 2, SCENERY_BACK, SCENERY_PERIOD),
      new FastScroller(headMesh, count * 2, SCENERY_BACK, SCENERY_PERIOD)
    );

    g.add(postMesh, headMesh);
    return g;
  }

  private buildInstancedFoliage(): THREE.Group {
    const g = new THREE.Group();
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x422006, roughness: 0.9 });
    const oakLeavesMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.85, flatShading: true });
    const pineLeavesMat = new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.88, flatShading: true });

    const spacing = 20;
    const count = Math.floor(SCENERY_PERIOD / spacing);

    const trunkGeo = new THREE.CylinderGeometry(0.2, 0.35, 3.5, 6);
    const oakGeo = new THREE.DodecahedronGeometry(3.2, 1);
    const pineGeo = new THREE.ConeGeometry(2.8, 6.5, 6);

    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, count * 2);
    const oakMesh = new THREE.InstancedMesh(oakGeo, oakLeavesMat, count);
    const pineMesh = new THREE.InstancedMesh(pineGeo, pineLeavesMat, count);

    let trunkIdx = 0;
    let oakIdx = 0;
    let pineIdx = 0;

    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const z = -i * spacing - 8;
        const xOffset = side * (ROAD_HALF + 5.5 + ((i * 3) % 4));

        const mt = new THREE.Matrix4();
        mt.setPosition(xOffset, 1.75, z);
        trunkMesh.setMatrixAt(trunkIdx++, mt);

        if ((i + (side > 0 ? 1 : 0)) % 2 === 0) {
          const mo = new THREE.Matrix4();
          const scale = 0.85 + ((i * 3) % 4) * 0.12;
          mo.makeScale(scale, scale * 1.1, scale);
          mo.setPosition(xOffset, 4.5, z);
          oakMesh.setMatrixAt(oakIdx++, mo);
        } else {
          const mp = new THREE.Matrix4();
          const scale = 0.9 + ((i * 5) % 3) * 0.15;
          mp.makeScale(scale, scale, scale);
          mp.setPosition(xOffset, 5.2, z);
          pineMesh.setMatrixAt(pineIdx++, mp);
        }
      }
    }

    trunkMesh.instanceMatrix.needsUpdate = true;
    oakMesh.instanceMatrix.needsUpdate = true;
    pineMesh.instanceMatrix.needsUpdate = true;

    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    oakMesh.castShadow = true;
    oakMesh.receiveShadow = true;
    pineMesh.castShadow = true;
    pineMesh.receiveShadow = true;

    this.scrollers.push(
      new FastScroller(trunkMesh, trunkIdx, SCENERY_BACK, SCENERY_PERIOD),
      new FastScroller(oakMesh, oakIdx, SCENERY_BACK, SCENERY_PERIOD),
      new FastScroller(pineMesh, pineIdx, SCENERY_BACK, SCENERY_PERIOD)
    );

    g.add(trunkMesh, oakMesh, pineMesh);
    return g;
  }

  private populate3DScenery(): void {
    while (this.dynamicSceneryGroup.children.length > 0) {
      this.dynamicSceneryGroup.remove(this.dynamicSceneryGroup.children[0]);
    }
    this.sceneryProps = [];

    const addProp = (obj: THREE.Object3D, x: number, y: number, z: number, rotY = 0, scale = 1): void => {
      obj.position.set(x, y, z);
      obj.rotation.y = rotY;
      if (scale !== 1) obj.scale.setScalar(scale);
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      this.dynamicSceneryGroup.add(obj);
      this.sceneryProps.push({ obj, initZ: z, period: SCENERY_PERIOD });
    };

    const landmarkInterval = 28.0;
    const numSlots = Math.floor(SCENERY_PERIOD / landmarkInterval);

    for (let i = 0; i < numSlots; i++) {
      const z = -i * landmarkInterval - 20;
      const biome = Math.floor((-z % SCENERY_PERIOD) / 400);

      for (const side of [-1, 1]) {
        // Buildings placed along the sidewalk promenade (X = ±22.0m to ±25.0m)
        const x = side * (22.0 + ((i * 3) % 3));
        const facing = side > 0 ? -Math.PI / 2 : Math.PI / 2;

        if (biome === 0) {
          if (assetLoader.towers.length) {
            const tmpl = assetLoader.towers[(i + (side > 0 ? 2 : 0)) % assetLoader.towers.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          }
        } else if (biome === 1) {
          // Biome 1: Commercial Highway Strip (Shops, Cafes, Storefronts, Supermarkets)
          if (assetLoader.shops.length) {
            const tmpl = assetLoader.shops[(i * 2 + (side > 0 ? 1 : 0)) % assetLoader.shops.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          }
        } else if (biome === 2) {
          // Biome 2: Suburban Neighborhood (Two-story villas, houses, cottages)
          if (assetLoader.houses.length) {
            const tmpl = assetLoader.houses[(i * 2 + (side > 0 ? 1 : 0)) % assetLoader.houses.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          }
        } else if (biome === 3) {
          // Biome 3: Forest Canyon & Mountain Boulders (Rocks, Ancient Trees, Rustic Shacks)
          if (assetLoader.trees.length) {
            const tmpl = assetLoader.trees[(i * 3) % assetLoader.trees.length];
            addProp(tmpl.clone(true), x, 0, z, (i * 90 * Math.PI) / 180, 1.2);
          } else if (assetLoader.houses.length) {
            const tmpl = assetLoader.houses[(i + 4) % assetLoader.houses.length];
            addProp(tmpl.clone(true), x, 0, z, facing, 0.9);
          }
        } else {
          // Biome 4: Farmland Countryside & Mills (Red barns, Windmills, Silos, Ferris Wheel)
          if (side < 0 && assetLoader.pastoralProps.length) {
            const tmpl = assetLoader.pastoralProps[(i * 2) % assetLoader.pastoralProps.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          } else if (assetLoader.houses.length) {
            const tmpl = assetLoader.houses[(i + 2) % assetLoader.houses.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          }
        }
      }
    }

    // Parallel Railway Line with Moving Train on right side of Biome 4
    this.buildParallelRailwayTrack();
  }

  private buildParallelRailwayTrack(): void {
    if (!assetLoader.railwayCars.length) return;

    this.trainGroup = new THREE.Group();
    const trainZ = -1750;
    const railX = ROAD_HALF + 22.0;

    let carOffsetZ = 0;
    for (let c = 0; c < Math.min(8, assetLoader.railwayCars.length); c++) {
      const tmpl = assetLoader.railwayCars[c];
      const car = tmpl.clone(true);
      car.position.set(0, 0, carOffsetZ);
      car.rotation.y = 0;
      this.trainGroup.add(car);
      carOffsetZ += 16.0;
    }

    this.trainGroup.position.set(railX, 0.4, trainZ);
    this.dynamicSceneryGroup.add(this.trainGroup);
  }

  private buildDistantMountains(): THREE.Group {
    const g = new THREE.Group();
    const mGeo = new THREE.ConeGeometry(90, 75, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.95,
      flatShading: true
    });

    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(mGeo, mat);
      const x = (i % 2 === 0 ? -1 : 1) * (180 + (i * 35) % 80);
      const z = -200 - i * 110;
      m.position.set(x, 35, z);
      g.add(m);
    }
    return g;
  }

  /**
   * 3-Layered Volumetric Cumulus Clouds with warm sun scattering and parallax drift
   */
  private buildLayeredCumulusClouds(): THREE.Group {
    this.cloudsGroup = new THREE.Group();
    this.cloudLayers = [];

    const puffGeo = new THREE.DodecahedronGeometry(14, 1);
    const cloudMat1 = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      transparent: true,
      opacity: 0.85
    });
    const cloudMat2 = new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      roughness: 0.9,
      transparent: true,
      opacity: 0.7
    });

    // Layer 1: Low fast cumulus puffs (Altitude 80m)
    for (let i = 0; i < 12; i++) {
      const cluster = new THREE.Group();
      for (let p = 0; p < 4; p++) {
        const puff = new THREE.Mesh(puffGeo, cloudMat1);
        puff.position.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 22);
        puff.scale.set(1.4 + Math.random() * 0.5, 0.6 + Math.random() * 0.3, 1.2 + Math.random() * 0.4);
        cluster.add(puff);
      }
      cluster.position.set((Math.random() - 0.5) * 350, 75 + Math.random() * 15, -Math.random() * 800);
      this.cloudsGroup.add(cluster);
      this.cloudLayers.push({ mesh: cluster, speedX: 0.015, speedZ: -0.04 });
    }

    // Layer 2: Mid-level golden rim clouds (Altitude 115m)
    for (let i = 0; i < 8; i++) {
      const cluster = new THREE.Group();
      for (let p = 0; p < 5; p++) {
        const puff = new THREE.Mesh(puffGeo, cloudMat2);
        puff.position.set((Math.random() - 0.5) * 35, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 35);
        puff.scale.set(2.0 + Math.random() * 0.6, 0.7 + Math.random() * 0.3, 1.8 + Math.random() * 0.5);
        cluster.add(puff);
      }
      cluster.position.set((Math.random() - 0.5) * 450, 115 + Math.random() * 20, -Math.random() * 900);
      this.cloudsGroup.add(cluster);
      this.cloudLayers.push({ mesh: cluster, speedX: -0.008, speedZ: -0.02 });
    }

    return this.cloudsGroup;
  }
}

class FastScroller {
  private array: Float32Array;

  constructor(
    private mesh: THREE.InstancedMesh,
    private count: number,
    private backZ: number,
    private period: number
  ) {
    this.array = mesh.instanceMatrix.array as Float32Array;
  }

  update(scroll: number): void {
    const arr = this.array;
    const count = this.count;
    const backZ = this.backZ;
    const period = this.period;

    for (let i = 0; i < count; i++) {
      const idx = i * 16 + 14;
      let z = arr[idx] + scroll;
      if (z > backZ) z -= period;
      arr[idx] = z;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
