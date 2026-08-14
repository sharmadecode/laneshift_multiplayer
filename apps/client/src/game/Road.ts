import * as THREE from 'three';
import {
  LANE_COUNT,
  LANE_WIDTH,
  ROAD_HALF_WIDTH,
  getTrackCurvature,
  getCurveOffset,
  getCurveYaw
} from '@hr/shared';
import { assetLoader } from './AssetLoader';

const ROAD_HALF = ROAD_HALF_WIDTH;
const TILE_LEN = 100; // exact integer tile length for zero-jitter wrapping (m)
const GROUND_LEN = 1600; // ground plane depth (16 exact tiles)
const GROUND_CENTER = (8 - (GROUND_LEN - 8)) / 2;
const SCENERY_BACK = 60; // recycle objects when they pass this z
const SCENERY_PERIOD = 2000; // 5 rich biomes x 400m each

export type WeatherPreset = 'day' | 'sunset' | 'night' | 'rain';

export interface RoadOptions {
  shadows: boolean;
  buildingsPerSide: number;
  lampsPerSide: number;
}

interface SceneryProp {
  obj: THREE.Object3D;
  initZ: number;
  baseX: number;
  baseRotY: number;
  period: number;
}

export class Road {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private groundTex!: THREE.CanvasTexture;
  private sidewalkTex!: THREE.CanvasTexture;
  private grassTex!: THREE.CanvasTexture;
  private groundGeo!: THREE.PlaneGeometry;
  private sidewalkGeos: { geo: THREE.PlaneGeometry; baseOffset: number }[] = [];
  private terrainGeo!: THREE.PlaneGeometry;
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

  /** Radially-tiled 3-band Anime Sky Dome with stylized sun flare and shimmering stars. Fog-immune. */
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
          
          // 3-band stylized anime sky gradient
          vec3 sky;
          if (h < 0.45) {
            float t = h / 0.45;
            sky = mix(horizonColor, midColor, smoothstep(0.0, 1.0, t));
          } else {
            float t = (h - 0.45) / 0.55;
            sky = mix(midColor, topColor, smoothstep(0.0, 1.0, t));
          }
          
          // Stylized crisp Anime Sun Disc with halo ring
          float s = max(dot(vDir, sunDir), 0.0);
          float sunDisc = smoothstep(0.994, 0.997, s) * 3.5;
          float sunGlow = pow(s, 24.0) * 0.45 + pow(s, 4.0) * 0.18;
          float sunRing = smoothstep(0.985, 0.988, s) * (1.0 - smoothstep(0.988, 0.993, s)) * 0.6;
          sky += sunColor * (sunDisc + sunGlow + sunRing);
          
          // Shimmering Anime Stars
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

    // Highway Ground and Infrastructure
    this.group.add(this.buildPBRHighwaySurface());
    this.group.add(this.buildSidewalkBoulevards());
    this.group.add(this.buildLushMeadowTerrain());
    this.group.add(this.buildRoadCurbsAndGuardrails());
    this.group.add(this.buildInstancedStreetlamps());
    this.group.add(this.buildInstancedFoliage());
    this.group.add(this.dynamicSceneryGroup);
    this.group.add(this.buildDistantMountains());
    this.group.add(this.buildSummerClouds());
    this.buildRainSystem(scene);

    scene.add(this.group);

    // Populate 3D GLB Scenery once assets are loaded
    assetLoader.onReady(() => {
      this.populate3DScenery();
    });
  }

  private buildRainSystem(scene: THREE.Scene): void {
    const count = 1200;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 60;
      pos[i * 3 + 1] = Math.random() * 35;
      pos[i * 3 + 2] = -Math.random() * 80 + 15;
    }
    this.rainGeo = new THREE.BufferGeometry();
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const rainMat = new THREE.PointsMaterial({
      color: 0x93c5fd,
      size: 0.28,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending
    });
    this.rainPoints = new THREE.Points(this.rainGeo, rainMat);
    this.rainPoints.visible = false;
    scene.add(this.rainPoints);
  }

  setWeather(preset: WeatherPreset): void {
    const u = this.skyMat.uniforms;
    if (preset === 'sunset') {
      const fogCol = 0xf472b6;
      this.sceneRef.background = new THREE.Color(fogCol);
      this.sceneRef.fog = new THREE.FogExp2(fogCol, 0.0022);
      u.topColor.value.setHex(0x31103f);
      u.midColor.value.setHex(0xdb2777);
      u.horizonColor.value.setHex(0xfbbf24);
      u.sunColor.value.setHex(0xfef08a);
      u.sunDir.value.set(0.75, 0.25, -0.4).normalize();
      u.starIntensity.value = 0.0;
      this.sun.color.setHex(0xfb923c);
      this.sun.intensity = 1.45;
      this.hemi.color.setHex(0xf472b6);
      this.hemi.groundColor.setHex(0x78350f);
      this.hemi.intensity = 0.85;
      if (this.rainPoints) this.rainPoints.visible = false;
      this.asphaltMat.roughness = 0.45;
      this.asphaltMat.metalness = 0.1;
      this.sidewalkMat.roughness = 0.75;
    } else if (preset === 'night') {
      const fogCol = 0x0f172a;
      this.sceneRef.background = new THREE.Color(fogCol);
      this.sceneRef.fog = new THREE.FogExp2(fogCol, 0.0025);
      u.topColor.value.setHex(0x020617);
      u.midColor.value.setHex(0x1e1b4b);
      u.horizonColor.value.setHex(0x0891b2);
      u.sunColor.value.setHex(0xe0e7ff);
      u.sunDir.value.set(-0.4, 0.85, -0.3).normalize();
      u.starIntensity.value = 1.0;
      this.sun.color.setHex(0x818cf8);
      this.sun.intensity = 0.55;
      this.hemi.color.setHex(0x312e81);
      this.hemi.groundColor.setHex(0x09090b);
      this.hemi.intensity = 0.45;
      if (this.rainPoints) this.rainPoints.visible = false;
      this.asphaltMat.roughness = 0.4;
      this.asphaltMat.metalness = 0.1;
      this.sidewalkMat.roughness = 0.65;
    } else if (preset === 'rain') {
      const fogCol = 0x334155;
      this.sceneRef.background = new THREE.Color(fogCol);
      this.sceneRef.fog = new THREE.FogExp2(fogCol, 0.0035);
      u.topColor.value.setHex(0x1e293b);
      u.midColor.value.setHex(0x475569);
      u.horizonColor.value.setHex(0x64748b);
      u.sunColor.value.setHex(0x94a3b8);
      u.sunDir.value.set(0.3, 0.9, -0.2).normalize();
      u.starIntensity.value = 0.0;
      this.sun.color.setHex(0x94a3b8);
      this.sun.intensity = 0.75;
      this.hemi.color.setHex(0x334155);
      this.hemi.groundColor.setHex(0x1e293b);
      this.hemi.intensity = 0.65;
      if (this.rainPoints) this.rainPoints.visible = true;
      this.asphaltMat.roughness = 0.15;
      this.asphaltMat.metalness = 0.35;
      this.sidewalkMat.roughness = 0.3;
    } else {
      const fogCol = 0xb8e2ff;
      this.sceneRef.background = new THREE.Color(fogCol);
      this.sceneRef.fog = new THREE.FogExp2(fogCol, 0.0018);
      u.topColor.value.setHex(0x0284c7);
      u.midColor.value.setHex(0x38bdf8);
      u.horizonColor.value.setHex(0xfef08a);
      u.sunColor.value.setHex(0xfffbeb);
      u.sunDir.value.set(0.52, 0.76, -0.32).normalize();
      u.starIntensity.value = 0.0;
      this.sun.color.setHex(0xfffbeb);
      this.sun.intensity = 1.85;
      this.hemi.color.setHex(0x38bdf8);
      this.hemi.groundColor.setHex(0x22c55e);
      this.hemi.intensity = 1.15;
      if (this.rainPoints) this.rainPoints.visible = false;
      this.asphaltMat.roughness = 0.45;
      this.asphaltMat.metalness = 0.1;
      this.sidewalkMat.roughness = 0.8;
    }
  }

  update(scroll: number, playerX = 0, playerDist = 0): void {
    // 1. Ultra-fast direct Float32Array matrix scroller with curve offsets (zero GC allocations)
    for (let i = 0; i < this.scrollers.length; i++) {
      this.scrollers[i].update(scroll, playerDist);
    }

    // 2. Scroll & curve 3D Scenery props (landmarks, towers, houses, shops, barns)
    for (let i = 0; i < this.sceneryProps.length; i++) {
      const p = this.sceneryProps[i];
      p.obj.position.z += scroll;
      if (p.obj.position.z > SCENERY_BACK) {
        p.obj.position.z -= p.period;
      }
      const relDepth = Math.max(0, -p.obj.position.z);
      const curveX = getCurveOffset(playerDist, relDepth);
      const curveYaw = getCurveYaw(playerDist, relDepth);
      p.obj.position.x = p.baseX + curveX;
      p.obj.rotation.y = p.baseRotY + curveYaw;
    }

    // 3. Scroll parallel railway train with road curve
    if (this.trainGroup) {
      this.trainGroup.position.z += scroll * 0.45;
      if (this.trainGroup.position.z > SCENERY_BACK + 100) {
        this.trainGroup.position.z -= SCENERY_PERIOD;
      }
      const trainDepth = Math.max(0, -this.trainGroup.position.z);
      const curveX = getCurveOffset(playerDist, trainDepth);
      const curveYaw = getCurveYaw(playerDist, trainDepth);
      this.trainGroup.position.x = -68 + curveX;
      this.trainGroup.rotation.y = curveYaw;
    }

    // 4. Update GPU Ground, Sidewalk & Meadow Mesh Curves
    this.updateGroundPlaneCurves(playerDist);

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
      for (let i = 0; i < count; i++) {
        pos[i * 3 + 1] -= 0.85;
        if (pos[i * 3 + 1] < 0) {
          pos[i * 3 + 1] = 30 + Math.random() * 8;
          pos[i * 3] = playerX + (Math.random() - 0.5) * 55;
          pos[i * 3 + 2] = -playerDist - Math.random() * 80 + 15;
        }
      }
      this.rainGeo.attributes.position.needsUpdate = true;
    }
  }

  private updateGroundPlaneCurves(playerDist: number): void {
    const SEGMENTS = 80;
    // 1. Asphalt Road Surface
    if (this.groundGeo) {
      const pos = this.groundGeo.attributes.position.array as Float32Array;
      for (let r = 0; r <= SEGMENTS; r++) {
        const localY = (0.5 - r / SEGMENTS) * GROUND_LEN;
        const worldZ = GROUND_CENTER - localY;
        const depth = Math.max(0, -worldZ);
        const curveX = getCurveOffset(playerDist, depth);

        const vLeft = r * 2;
        const vRight = r * 2 + 1;
        pos[vLeft * 3] = -ROAD_HALF + curveX;
        pos[vRight * 3] = ROAD_HALF + curveX;
      }
      this.groundGeo.attributes.position.needsUpdate = true;
    }

    // 2. Sidewalk Boulevards
    const sideWidth = 14;
    for (const item of this.sidewalkGeos) {
      const pos = item.geo.attributes.position.array as Float32Array;
      const baseCenter = item.baseOffset;
      for (let r = 0; r <= SEGMENTS; r++) {
        const localY = (0.5 - r / SEGMENTS) * GROUND_LEN;
        const worldZ = GROUND_CENTER - localY;
        const depth = Math.max(0, -worldZ);
        const curveX = getCurveOffset(playerDist, depth);

        const vLeft = r * 2;
        const vRight = r * 2 + 1;
        pos[vLeft * 3] = baseCenter - sideWidth / 2 + curveX;
        pos[vRight * 3] = baseCenter + sideWidth / 2 + curveX;
      }
      item.geo.attributes.position.needsUpdate = true;
    }

    // 3. Meadow Terrain
    if (this.terrainGeo) {
      const pos = this.terrainGeo.attributes.position.array as Float32Array;
      for (let r = 0; r <= SEGMENTS; r++) {
        const localY = (0.5 - r / SEGMENTS) * GROUND_LEN;
        const worldZ = GROUND_CENTER - localY;
        const depth = Math.max(0, -worldZ);
        const curveX = getCurveOffset(playerDist, depth);

        const vLeft = r * 2;
        const vRight = r * 2 + 1;
        pos[vLeft * 3] = -275 + curveX;
        pos[vRight * 3] = 275 + curveX;
      }
      this.terrainGeo.attributes.position.needsUpdate = true;
    }
  }

  /**
   * Generates a high-definition PBR asphalt texture complete with:
   * - 3 cleanly separated lanes
   * - White dashed center lane dividers (- - - -)
   * - Crisp solid white shoulder lines
   * - Retro-reflective Cat's Eye pavement markers (road studs)
   * - Outer safety curb hazard stripes and asphalt grit noise
   */
  private buildPBRHighwaySurface(): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 1024;
    cv.height = 2048;
    const ctx = cv.getContext('2d')!;

    // 1. Dark asphalt base
    ctx.fillStyle = '#14171f';
    ctx.fillRect(0, 0, 1024, 2048);

    // 2. Micro-grit texture
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

    // Dividers are at X = -2.25m and X = +2.25m
    const divLeftX = midX - 2.25 * pxPerMeter;
    const divRightX = midX + 2.25 * pxPerMeter;

    // Shoulder lines at ±6.75m
    const shoulderLeftX = midX - 6.75 * pxPerMeter;
    const shoulderRightX = midX + 6.75 * pxPerMeter;

    // 3. Solid White Shoulder Lines with crisp borders
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(shoulderLeftX - 6, 0, 12, 2048);
    ctx.fillRect(shoulderRightX - 6, 0, 12, 2048);

    // 4. Dashed Center Lane Dividers (4m dash, 6m gap in 100m tile -> repeat pattern)
    const pixelsPerTileM = 2048 / TILE_LEN;
    const dashPx = 4.0 * pixelsPerTileM;
    const gapPx = 6.0 * pixelsPerTileM;
    const periodPx = dashPx + gapPx;

    ctx.fillStyle = '#f8fafc';
    for (let y = 0; y < 2048; y += periodPx) {
      ctx.fillRect(divLeftX - 5, y, 10, dashPx);
      ctx.fillRect(divRightX - 5, y, 10, dashPx);
    }

    // 5. Retro-reflective Cat's Eye Pavement Studs (amber glow)
    const studSpacingPx = 16.0 * pixelsPerTileM;
    for (let y = 0; y < 2048; y += studSpacingPx) {
      // Lane divider studs (Amber yellow)
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(divLeftX - 4, y, 8, 8);
      ctx.fillRect(divRightX - 4, y, 8, 8);

      // Shoulder studs (White / Red)
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(shoulderLeftX - 4, y, 8, 8);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(shoulderRightX - 4, y, 8, 8);
    }

    // 6. Curb edge hazard accents
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

    this.groundGeo = new THREE.PlaneGeometry(ROAD_HALF * 2, GROUND_LEN, 1, 80);
    const ground = new THREE.Mesh(
      this.groundGeo,
      this.asphaltMat
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, GROUND_CENTER);
    ground.receiveShadow = true;
    return ground;
  }

  /**
   * Concrete paved pedestrian promenade / sidewalk boulevard on both sides (X = ±8m to ±21m)
   */
  private buildSidewalkBoulevards(): THREE.Group {
    const g = new THREE.Group();
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 256;
    const ctx = cv.getContext('2d')!;

    // Concrete paving slabs texture
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

    this.sidewalkGeos = [];
    const sideWidth = 14; // 14m wide sidewalk from X=8m to X=22m
    for (const side of [-1, 1]) {
      const walkGeo = new THREE.PlaneGeometry(sideWidth, GROUND_LEN, 1, 80);
      const baseOffset = side * (ROAD_HALF + sideWidth / 2);
      this.sidewalkGeos.push({ geo: walkGeo, baseOffset });

      const walkMesh = new THREE.Mesh(
        walkGeo,
        this.sidewalkMat
      );
      walkMesh.rotation.x = -Math.PI / 2;
      walkMesh.position.set(0, -0.04, GROUND_CENTER);
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

    // Rich grassy meadow
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

    this.terrainGeo = new THREE.PlaneGeometry(550, GROUND_LEN, 1, 80);
    const terrain = new THREE.Mesh(this.terrainGeo, mat);
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
        // Trees positioned along sidewalk planter strip (X = 13.5m to 16.5m)
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

  /**
   * Spawns closer, high-impact 3D landmark buildings:
   * Placed along the pedestrian boulevard promenade at X = ±21m to ±26m.
   * Their front facades line the sidewalk directly, giving an immersive city corridor feel!
   */
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
      this.sceneryProps.push({ obj, initZ: z, baseX: x, baseRotY: rotY, period: SCENERY_PERIOD });
    };

    // 16 Landmark buildings spaced every 125m across the 5 Biomes
    const landmarkInterval = 125;
    const numSlots = Math.floor(SCENERY_PERIOD / landmarkInterval);

    for (let i = 0; i < numSlots; i++) {
      const z = -i * landmarkInterval - 30;
      const biome = Math.floor((-z % SCENERY_PERIOD) / 400);

      for (const side of [-1, 1]) {
        // Buildings placed closer (X = ±22m) right behind the 14m sidewalk!
        const x = side * (22.5 + ((i * 3) % 4));
        const facing = side > 0 ? -Math.PI / 2 : Math.PI / 2;

        if (biome === 0) {
          // Biome 0: Downtown Skyscraper Skyline (Towers & Highrises)
          if (assetLoader.towers.length) {
            const tmpl = assetLoader.towers[(i + (side > 0 ? 2 : 0)) % assetLoader.towers.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          }
        } else if (biome === 1) {
          // Biome 1: Commercial Strip (Shops, Supermarkets, Cafes)
          if (assetLoader.shops.length) {
            const tmpl = assetLoader.shops[(i * 2 + (side > 0 ? 1 : 0)) % assetLoader.shops.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          }
        } else if (biome === 2) {
          // Biome 2: Suburban Villas & Neighborhood (Houses)
          if (assetLoader.houses.length) {
            const tmpl = assetLoader.houses[(i * 2 + (side > 0 ? 1 : 0)) % assetLoader.houses.length];
            addProp(tmpl.clone(true), x, 0, z, facing);
          }
        } else if (biome === 3) {
          // Biome 3: Forest Canyon (Rock Formations, Ancient Trees)
          if (assetLoader.trees.length) {
            const tmpl = assetLoader.trees[(i * 3) % assetLoader.trees.length];
            addProp(tmpl.clone(true), x, 0, z, (i * 90 * Math.PI) / 180, 1.2);
          }
        } else {
          // Biome 4: Farmland Barns & Windmills
          if (side < 0 && assetLoader.pastoralProps.length) {
            const tmpl = assetLoader.pastoralProps[(i * 2) % assetLoader.pastoralProps.length];
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
    for (let c = 0; c < Math.min(5, assetLoader.railwayCars.length); c++) {
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

    // 3 Layered Anime Ridges (Emerald -> Indigo -> Twilight Purple)
    const layerColors = [0x15803d, 0x1d4ed8, 0x4338ca, 0x6d28d9];

    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: layerColors[i % layerColors.length],
        roughness: 0.85,
        flatShading: true
      });
      const m = new THREE.Mesh(mGeo, mat);
      const side = i % 2 === 0 ? 1 : -1;
      const x = side * (160 + (i % 5) * 45);
      const z = -400 - i * 50;
      const scale = 0.9 + (i % 4) * 0.3;
      m.scale.set(scale, scale * 1.25, scale);
      m.position.set(x, 28, z);
      g.add(m);
    }
    return g;
  }

  private buildSummerClouds(): THREE.Group {
    const g = new THREE.Group();
    const puffGeo = new THREE.SphereGeometry(1, 8, 8);
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      flatShading: true
    });

    for (let c = 0; c < 14; c++) {
      const cloud = new THREE.Group();
      for (let p = 0; p < 6; p++) {
        const puff = new THREE.Mesh(puffGeo, cloudMat);
        puff.scale.set(18, 14, 18);
        puff.position.set((Math.random() - 0.5) * 36, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 36);
        cloud.add(puff);
      }
      cloud.position.set((Math.random() - 0.5) * 650, 90 + Math.random() * 40, -350 - c * 45);
      g.add(cloud);
    }
    return g;
  }
}

/**
 * Ultra-fast direct Float32Array matrix scroller.
 * Directly increments the Z coordinate in instanceMatrix column-major buffer
 * (matrix index 14) and applies dynamic road curvature offsets along the spline.
 */
class FastScroller {
  private array: Float32Array;
  private basePositions: Float32Array;

  constructor(
    private mesh: THREE.InstancedMesh,
    private count: number,
    private backZ: number,
    private period: number
  ) {
    this.array = mesh.instanceMatrix.array as Float32Array;
    this.basePositions = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      this.basePositions[i * 2] = this.array[i * 16 + 12];
      this.basePositions[i * 2 + 1] = this.array[i * 16 + 13];
    }
  }

  update(scroll: number, playerDist = 0): void {
    const arr = this.array;
    const base = this.basePositions;
    const count = this.count;
    const backZ = this.backZ;
    const period = this.period;

    for (let i = 0; i < count; i++) {
      const idx = i * 16;
      let z = arr[idx + 14] + scroll;
      if (z > backZ) z -= period;
      arr[idx + 14] = z;

      const relDepth = Math.max(0, -z);
      const curveX = getCurveOffset(playerDist, relDepth);
      arr[idx + 12] = base[i * 2] + curveX;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
