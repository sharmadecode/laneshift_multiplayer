import * as THREE from 'three';
import { LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH } from '@hr/shared';

const ROAD_HALF = ROAD_HALF_WIDTH;
const TILE_LEN = 96; // texture tile length (m)
const GROUND_LEN = 1500; // ground plane depth
const GROUND_CENTER = (8 - (GROUND_LEN - 8)) / 2;
const SCENERY_BACK = 45; // recycle objects when they pass this z
const SCENERY_PERIOD = 1200;

interface InstanceData {
  x: number;
  z: number;
  sy: number;
  rotY?: number;
}

export interface RoadOptions {
  shadows: boolean;
  buildingsPerSide: number;
  lampsPerSide: number;
}

export class Road {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private groundTex!: THREE.CanvasTexture;
  private grassTex!: THREE.CanvasTexture;
  private scrollers: MatrixScroller[] = [];
  private cloudsGroup = new THREE.Group();
  private skyDome!: THREE.Mesh;

  /** Radially-tiled gradient sky dome with a bright sun disc. Fog-immune so it
   *  always reads as the true sky at any distance. */
  private buildSkyDome(scene: THREE.Scene): void {
    const domeGeo = new THREE.SphereGeometry(1, 48, 20);
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x1e63b5) },
        horizonColor: { value: new THREE.Color(0xbfe3ff) },
        sunColor: { value: new THREE.Color(0xfff2d0) },
        sunDir: { value: new THREE.Vector3(0.52, 0.76, -0.32).normalize() }
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
        uniform vec3 horizonColor;
        uniform vec3 sunColor;
        uniform vec3 sunDir;
        varying vec3 vDir;
        void main() {
          float h = vDir.y * 0.5 + 0.5;
          vec3 sky = mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.62));
          float s = max(dot(vDir, sunDir), 0.0);
          sky += sunColor * (pow(s, 220.0) * 3.0 + pow(s, 24.0) * 0.45 + pow(s, 6.0) * 0.12);
          gl_FragColor = vec4(sky, 1.0);
        }
      `
    });
    this.skyDome = new THREE.Mesh(domeGeo, domeMat);
    this.skyDome.position.set(0, 40, 0);
    this.skyDome.scale.setScalar(900);
    this.skyDome.renderOrder = -10;
    scene.add(this.skyDome);
  }

  /** Keeps the dome just inside the camera far plane so it is never clipped. */
  setFar(far: number): void {
    this.skyDome.scale.setScalar(Math.max(300, far * 0.92));
  }

  constructor(scene: THREE.Scene, opts: RoadOptions) {
    // --- Summer Afternoon Atmospheric Sky ---
    // Background and fog share the horizon color so the world melts into the
    // sky seamlessly; the gradient dome does the actual painting.
    const horizonColor = 0xbfe3ff;
    scene.background = new THREE.Color(horizonColor);
    scene.fog = new THREE.FogExp2(horizonColor, 0.002);
    this.buildSkyDome(scene);

    // --- Warm Golden Sun Lighting ---
    const hemi = new THREE.HemisphereLight(0x8acdfa, 0x5ea83c, 0.95);
    scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff8eb, 1.45);
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

    // Build World Elements
    this.group.add(this.buildDarkAsphalt());
    this.group.add(this.buildLushMeadow());
    this.group.add(this.buildRoadCurbsAndGuardrails());
    this.group.add(this.buildUtilityPolesAndCables(opts.lampsPerSide));
    this.group.add(this.buildDiverseNeighborhood(opts.buildingsPerSide));
    this.group.add(this.buildDiverseFoliage(opts.buildingsPerSide * 2));
    this.group.add(this.buildDistantMountains());
    this.group.add(this.buildSummerClouds());

    scene.add(this.group);
  }

  /** Advance the scenery by scroll meters (world moves toward +Z). */
  update(scroll: number, playerX = 0, playerZ = 0): void {
    for (const s of this.scrollers) s.update(scroll);
    this.groundTex.offset.y = (this.groundTex.offset.y + scroll / TILE_LEN) % 1;
    this.grassTex.offset.y = (this.grassTex.offset.y + scroll / 48) % 1;
    this.cloudsGroup.position.z += scroll * 0.025;
    if (this.cloudsGroup.position.z > 250) this.cloudsGroup.position.z -= 500;

    // Sun and its shadow frustum follow the player so shadow detail (and the
    // sun highlight on the car) stay consistent at any distance.
    this.sun.position.set(playerX + 65, 95, playerZ - 40);
    this.sun.target.position.set(playerX, 0, playerZ);
    this.sun.target.updateMatrixWorld();
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

  /** Realistic, rich dark asphalt highway with crisp markings and tire tread wear. */
  private buildDarkAsphalt(): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 1024;
    const ctx = cv.getContext('2d')!;

    // Rich dark charcoal asphalt base
    ctx.fillStyle = '#242832';
    ctx.fillRect(0, 0, 512, 1024);

    // Aggregate gravel noise & tar variation
    for (let i = 0; i < 6000; i++) {
      const g = 40 + Math.floor(Math.random() * 32);
      ctx.fillStyle = `rgba(${g},${g + 2},${g + 6},0.35)`;
      ctx.fillRect(Math.random() * 512, Math.random() * 1024, 2, 2);
    }

    // Subtle tire wear grooves in lane centers
    const px = 512 / (ROAD_HALF * 2);
    for (let i = 0; i < LANE_COUNT; i++) {
      const lx = 256 + (i - LANE_COUNT / 2 + 0.5) * LANE_WIDTH * px;
      ctx.fillStyle = 'rgba(24, 27, 34, 0.25)';
      ctx.fillRect(lx - 22, 0, 14, 1024);
      ctx.fillRect(lx + 8, 0, 14, 1024);
    }

    const edge = ((LANE_COUNT * LANE_WIDTH) / 2) * px;

    // Darker road shoulders
    ctx.fillStyle = 'rgba(20, 23, 30, 0.45)';
    ctx.fillRect(0, 0, 256 - edge - 4, 1024);
    ctx.fillRect(256 + edge + 4, 0, 256 - edge - 4, 1024);

    // Solid outer lane boundary lines
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(256 - edge - 4, 0, 6, 1024);
    ctx.fillRect(256 + edge - 2, 0, 6, 1024);

    // Crisp white dashed center lane separators with yellow accents
    ctx.fillStyle = '#ffffff';
    for (let i = 1; i < LANE_COUNT; i++) {
      const lx = 256 + (i - LANE_COUNT / 2) * LANE_WIDTH * px - 3;
      for (let y = 0; y < 1024; y += 192) {
        ctx.fillRect(lx, y, 6, 96);
      }
    }

    this.groundTex = new THREE.CanvasTexture(cv);
    this.groundTex.wrapS = THREE.ClampToEdgeWrapping;
    this.groundTex.wrapT = THREE.RepeatWrapping;
    this.groundTex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshStandardMaterial({
      map: this.groundTex,
      roughness: 0.78,
      metalness: 0.08
    });

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, GROUND_LEN), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, GROUND_CENTER);
    this.groundTex.repeat.set(1, GROUND_LEN / TILE_LEN);
    ground.receiveShadow = true;
    return ground;
  }

  /** Vibrant lush green rolling meadow terrain with sunny Ghibli grass variations. */
  private buildLushMeadow(): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 256;
    const ctx = cv.getContext('2d')!;

    // Rich warm emerald green base
    ctx.fillStyle = '#569e38';
    ctx.fillRect(0, 0, 256, 256);

    // Organic grass tufts & highlights
    for (let i = 0; i < 800; i++) {
      const g = 145 + Math.floor(Math.random() * 55);
      ctx.fillStyle = `rgba(75,${g},45,0.4)`;
      ctx.beginPath();
      ctx.arc(Math.random() * 256, Math.random() * 256, 4 + Math.random() * 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Roadside flower specks (white, yellow, and lavender)
    for (let i = 0; i < 200; i++) {
      const r = Math.random();
      ctx.fillStyle = r < 0.4 ? '#fff9c4' : r < 0.8 ? '#ffffff' : '#e0b0ff';
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }

    this.grassTex = new THREE.CanvasTexture(cv);
    this.grassTex.wrapS = this.grassTex.wrapT = THREE.RepeatWrapping;
    this.grassTex.repeat.set(16, 48);

    const mat = new THREE.MeshStandardMaterial({
      map: this.grassTex,
      roughness: 0.92,
      metalness: 0.0
    });

    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(450, GROUND_LEN), mat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(0, -0.06, GROUND_CENTER);
    terrain.receiveShadow = true;
    return terrain;
  }

  /** Roadside curbs and highway steel guardrails. */
  private buildRoadCurbsAndGuardrails(): THREE.Group {
    const g = new THREE.Group();
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.82 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, metalness: 0.85, roughness: 0.25 });

    const count = Math.ceil(SCENERY_PERIOD / 80);
    const curbMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.38, 0.22, 80), curbMat, count * 2);
    curbMesh.castShadow = true;
    curbMesh.receiveShadow = true;

    const guardrailMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.4, 80), railMat, count * 2);
    guardrailMesh.castShadow = true;

    const instances: InstanceData[] = [];
    const railInstances: InstanceData[] = [];

    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const z = -i * 80 - 10;
        const x = side * (ROAD_HALF + 0.22);
        const idx = instances.length;

        instances.push({ x, z, sy: 1 });
        const m = new THREE.Matrix4();
        m.setPosition(x, 0.11, z);
        curbMesh.setMatrixAt(idx, m);

        railInstances.push({ x: side * (ROAD_HALF + 0.8), z, sy: 1 });
        const mr = new THREE.Matrix4();
        mr.setPosition(side * (ROAD_HALF + 0.8), 0.55, z);
        guardrailMesh.setMatrixAt(idx, mr);
      }
    }

    curbMesh.instanceMatrix.needsUpdate = true;
    guardrailMesh.instanceMatrix.needsUpdate = true;

    this.scrollers.push(
      new MatrixScroller(curbMesh, instances, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(guardrailMesh, railInstances, SCENERY_BACK, SCENERY_PERIOD)
    );

    g.add(curbMesh, guardrailMesh);
    return g;
  }

  /** Utility poles with transformers and overhead power lines. */
  private buildUtilityPolesAndCables(perSide: number): THREE.Group {
    const g = new THREE.Group();
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x3e3228, roughness: 0.9 });
    const crossMat = new THREE.MeshStandardMaterial({ color: 0x544234, roughness: 0.85 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.8, roughness: 0.3 });
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x14161d });

    const poleGeo = new THREE.CylinderGeometry(0.14, 0.2, 8.0, 7);
    const crossGeo = new THREE.BoxGeometry(2.6, 0.18, 0.18);
    const transGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.8, 8);
    const spacing = SCENERY_PERIOD / perSide;

    const poles = new THREE.InstancedMesh(poleGeo, woodMat, perSide * 2);
    const crossbars = new THREE.InstancedMesh(crossGeo, crossMat, perSide * 2);
    const transformers = new THREE.InstancedMesh(transGeo, metalMat, perSide * 2);

    poles.castShadow = true;
    crossbars.castShadow = true;
    transformers.castShadow = true;

    const sPoles: InstanceData[] = [];
    const sCross: InstanceData[] = [];
    const sTrans: InstanceData[] = [];

    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const z = -i * spacing - 10;
        const x = side * (ROAD_HALF + 2.6);
        const idx = sPoles.length;
        sPoles.push({ x, z, sy: 1 });
        sCross.push({ x, z, sy: 1 });
        sTrans.push({ x, z, sy: 1 });

        const mp = new THREE.Matrix4();
        mp.setPosition(x, 4.0, z);
        poles.setMatrixAt(idx, mp);

        const mc = new THREE.Matrix4();
        mc.setPosition(x, 7.4, z);
        crossbars.setMatrixAt(idx, mc);

        const mt = new THREE.Matrix4();
        mt.setPosition(x + side * 0.35, 6.2, z);
        transformers.setMatrixAt(idx, mt);
      }
    }

    poles.instanceMatrix.needsUpdate = true;
    crossbars.instanceMatrix.needsUpdate = true;
    transformers.instanceMatrix.needsUpdate = true;

    this.scrollers.push(
      new MatrixScroller(poles, sPoles, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(crossbars, sCross, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(transformers, sTrans, SCENERY_BACK, SCENERY_PERIOD)
    );

    // Continuous overhead power cables
    for (const side of [-1, 1]) {
      const wireX = side * (ROAD_HALF + 2.6);
      for (const wireOffset of [-1.0, 1.0]) {
        const wireGeo = new THREE.CylinderGeometry(0.015, 0.015, GROUND_LEN, 4);
        const wire = new THREE.Mesh(wireGeo, wireMat);
        wire.position.set(wireX + wireOffset, 7.35, GROUND_CENTER);
        wire.rotation.x = Math.PI / 2;
        g.add(wire);
      }
    }

    g.add(poles, crossbars, transformers);
    return g;
  }

  /** Diverse architectural styles: Modern Japanese Suburban, European Cottages, Beach Villas, and Konbini Shops. */
  private buildDiverseNeighborhood(perSide: number): THREE.Group {
    const g = new THREE.Group();

    // 1. Procedural Textures for different building types
    const createFacadeTexture = (type: 'cottage' | 'modern' | 'konbini'): THREE.CanvasTexture => {
      const cv = document.createElement('canvas');
      cv.width = 256;
      cv.height = 256;
      const ctx = cv.getContext('2d')!;

      if (type === 'modern') {
        ctx.fillStyle = '#eaeef2';
        ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = '#334155'; // Dark cedar wood panel
        ctx.fillRect(0, 0, 70, 256);
        // Panoramic glass windows
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(90, 40, 140, 70);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(90, 140, 140, 100); // Garage shutter
      } else if (type === 'konbini') {
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, 256, 256);
        // Storefront Canopy Stripes (Red/Blue/Orange)
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(0, 0, 256, 45);
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(0, 45, 256, 15);
        // Big glass display window
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(20, 80, 216, 140);
      } else {
        // European Cottage
        ctx.fillStyle = '#fbf7ee';
        ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = '#5c4033'; // base trim
        ctx.fillRect(0, 240, 256, 16);
        // Windows with shutters
        const drawWindow = (wx: number, wy: number) => {
          ctx.fillStyle = '#1e293b';
          ctx.fillRect(wx, wy, 50, 60);
          ctx.fillStyle = '#8b5a2b'; // shutters
          ctx.fillRect(wx - 14, wy, 12, 60);
          ctx.fillRect(wx + 52, wy, 12, 60);
        };
        drawWindow(45, 40);
        drawWindow(160, 40);
        // Front Door
        ctx.fillStyle = '#78350f';
        ctx.fillRect(150, 140, 60, 100);
      }

      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };

    const cottageTex = createFacadeTexture('cottage');
    const modernTex = createFacadeTexture('modern');
    const konbiniTex = createFacadeTexture('konbini');

    const cottageMat = new THREE.MeshStandardMaterial({ map: cottageTex, roughness: 0.85 });
    const modernMat = new THREE.MeshStandardMaterial({ map: modernTex, roughness: 0.8 });
    const konbiniMat = new THREE.MeshStandardMaterial({ map: konbiniTex, roughness: 0.75 });

    const roofColors = [0xd35400, 0xc0392b, 0x1e293b, 0x2563eb, 0xd97706, 0x475569];
    const roofGeo = new THREE.ConeGeometry(0.85, 0.6, 4);
    roofGeo.rotateY(Math.PI / 4);
    const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.1 });

    const houseGeo = new THREE.BoxGeometry(1, 1, 1);
    const vendGeo = new THREE.BoxGeometry(1.2, 1.9, 0.9);
    const vendMat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.4, roughness: 0.3 }); // Red vending machine

    const houseMesh1 = new THREE.InstancedMesh(houseGeo, cottageMat, perSide);
    const houseMesh2 = new THREE.InstancedMesh(houseGeo, modernMat, perSide);
    const houseMesh3 = new THREE.InstancedMesh(houseGeo, konbiniMat, perSide);
    const roofMesh = new THREE.InstancedMesh(roofGeo, roofMat, perSide * 2);
    const vendMesh = new THREE.InstancedMesh(vendGeo, vendMat, perSide);

    houseMesh1.castShadow = houseMesh1.receiveShadow = true;
    houseMesh2.castShadow = houseMesh2.receiveShadow = true;
    houseMesh3.castShadow = houseMesh3.receiveShadow = true;
    roofMesh.castShadow = true;
    vendMesh.castShadow = true;

    const sHouses1: InstanceData[] = [];
    const sHouses2: InstanceData[] = [];
    const sHouses3: InstanceData[] = [];
    const sRoofs: InstanceData[] = [];
    const sVends: InstanceData[] = [];
    const spacing = SCENERY_PERIOD / perSide;

    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const z = -i * spacing - 15 - Math.random() * 20;
        const x = side * (ROAD_HALF + 11.5 + Math.random() * 16);
        const w = 11 + Math.random() * 5;
        const h = 7.5 + Math.random() * 3.5;
        const d = 12 + Math.random() * 5;
        const style = i % 3;

        const it = { x, z, sy: 1 };
        sRoofs.push({ ...it });

        const mr = new THREE.Matrix4();
        mr.makeScale(w * 1.08, h * 0.65, d * 1.08);
        mr.setPosition(x, h + (h * 0.65) / 2, z);
        const rIdx = sRoofs.length - 1;
        roofMesh.setMatrixAt(rIdx, mr);
        roofMesh.setColorAt(rIdx, new THREE.Color(roofColors[rIdx % roofColors.length]));

        const mh = new THREE.Matrix4();
        mh.makeScale(w, h, d);
        mh.setPosition(x, h / 2, z);

        if (style === 0) {
          sHouses1.push({ ...it });
          houseMesh1.setMatrixAt(sHouses1.length - 1, mh);
        } else if (style === 1) {
          sHouses2.push({ ...it });
          houseMesh2.setMatrixAt(sHouses2.length - 1, mh);
        } else {
          sHouses3.push({ ...it });
          houseMesh3.setMatrixAt(sHouses3.length - 1, mh);

          // Place roadside vending machine beside the shop
          sVends.push({ x: x - side * (w / 2 + 1.6), z: z + 2, sy: 1 });
          const mv = new THREE.Matrix4();
          mv.setPosition(x - side * (w / 2 + 1.6), 0.95, z + 2);
          vendMesh.setMatrixAt(sVends.length - 1, mv);
        }
      }
    }

    houseMesh1.instanceMatrix.needsUpdate = true;
    houseMesh2.instanceMatrix.needsUpdate = true;
    houseMesh3.instanceMatrix.needsUpdate = true;
    roofMesh.instanceMatrix.needsUpdate = true;
    roofMesh.instanceColor!.needsUpdate = true;
    vendMesh.instanceMatrix.needsUpdate = true;

    this.scrollers.push(
      new MatrixScroller(houseMesh1, sHouses1, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(houseMesh2, sHouses2, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(houseMesh3, sHouses3, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(roofMesh, sRoofs, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(vendMesh, sVends, SCENERY_BACK, SCENERY_PERIOD)
    );

    g.add(houseMesh1, houseMesh2, houseMesh3, roofMesh, vendMesh);
    return g;
  }

  /** Diverse foliage: Ghibli Broadleaf Trees, Japanese Pine/Cypress, Palm Trees, and Flower Bushes. */
  private buildDiverseFoliage(count: number): THREE.Group {
    const g = new THREE.Group();
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x48362a, roughness: 0.9 });
    const leafColors = [0x5aa038, 0x6cb345, 0x78d856, 0x2e7d32, 0x1b5e20, 0x43a047];

    // Broadleaf Oak canopy
    const oakGeo = new THREE.DodecahedronGeometry(5.4, 1);
    const oakTrunkGeo = new THREE.CylinderGeometry(0.45, 0.75, 6.5, 7);

    // Japanese Pine tiered pads
    const pineGeo = new THREE.ConeGeometry(3.6, 2.2, 6);
    const pineTrunkGeo = new THREE.CylinderGeometry(0.3, 0.5, 7.5, 6);

    // Flowering Bush
    const bushGeo = new THREE.SphereGeometry(1.6, 7, 7);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x66bb6a, roughness: 0.85 });

    const oakMesh = new THREE.InstancedMesh(oakGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), count / 2);
    const oakTrunkMesh = new THREE.InstancedMesh(oakTrunkGeo, trunkMat, count / 2);
    const pineMesh = new THREE.InstancedMesh(pineGeo, new THREE.MeshStandardMaterial({ roughness: 0.85 }), count / 2);
    const pineTrunkMesh = new THREE.InstancedMesh(pineTrunkGeo, trunkMat, count / 2);
    const bushMesh = new THREE.InstancedMesh(bushGeo, bushMat, count / 2);

    oakMesh.castShadow = true;
    oakTrunkMesh.castShadow = true;
    pineMesh.castShadow = true;
    pineTrunkMesh.castShadow = true;
    bushMesh.castShadow = true;

    const sOak: InstanceData[] = [];
    const sOakTrunk: InstanceData[] = [];
    const sPine: InstanceData[] = [];
    const sPineTrunk: InstanceData[] = [];
    const sBush: InstanceData[] = [];

    const spacing = SCENERY_PERIOD / (count / 2);

    for (const side of [-1, 1]) {
      for (let i = 0; i < count / 2; i++) {
        const z = -i * spacing - 6 - Math.random() * 20;
        const x = side * (ROAD_HALF + 5.5 + Math.random() * 28);
        const isPine = i % 2 === 0;

        if (isPine) {
          const scale = 1.4 + Math.random() * 1.0;
          sPine.push({ x, z, sy: scale });
          sPineTrunk.push({ x, z, sy: scale });

          const idx = sPine.length - 1;
          const mt = new THREE.Matrix4();
          mt.makeScale(scale, scale, scale);
          mt.setPosition(x, 3.75 * scale, z);
          pineTrunkMesh.setMatrixAt(idx, mt);

          const mp = new THREE.Matrix4();
          mp.makeScale(scale * 1.2, scale * 1.3, scale * 1.2);
          mp.setPosition(x, (7.5 + 1.2) * scale, z);
          pineMesh.setMatrixAt(idx, mp);
          pineMesh.setColorAt(idx, new THREE.Color(0x2e7d32));
        } else {
          const scale = 1.6 + Math.random() * 1.2;
          sOak.push({ x, z, sy: scale });
          sOakTrunk.push({ x, z, sy: scale });

          const idx = sOak.length - 1;
          const mt = new THREE.Matrix4();
          mt.makeScale(scale, scale, scale);
          mt.setPosition(x, 3.25 * scale, z);
          oakTrunkMesh.setMatrixAt(idx, mt);

          const mo = new THREE.Matrix4();
          mo.makeScale(scale * 1.35, scale * 1.25, scale * 1.35);
          mo.setPosition(x, (6.5 + 3.4) * scale, z);
          oakMesh.setMatrixAt(idx, mo);
          oakMesh.setColorAt(idx, new THREE.Color(leafColors[idx % leafColors.length]));
        }

        // Roadside flowering bush
        sBush.push({ x: side * (ROAD_HALF + 2.8 + Math.random() * 2), z: z + 4, sy: 1 });
        const mb = new THREE.Matrix4();
        mb.setPosition(side * (ROAD_HALF + 2.8 + Math.random() * 2), 0.8, z + 4);
        bushMesh.setMatrixAt(sBush.length - 1, mb);
      }
    }

    oakMesh.instanceMatrix.needsUpdate = true;
    oakTrunkMesh.instanceMatrix.needsUpdate = true;
    oakMesh.instanceColor!.needsUpdate = true;
    pineMesh.instanceMatrix.needsUpdate = true;
    pineTrunkMesh.instanceMatrix.needsUpdate = true;
    pineMesh.instanceColor!.needsUpdate = true;
    bushMesh.instanceMatrix.needsUpdate = true;

    this.scrollers.push(
      new MatrixScroller(oakMesh, sOak, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(oakTrunkMesh, sOakTrunk, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(pineMesh, sPine, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(pineTrunkMesh, sPineTrunk, SCENERY_BACK, SCENERY_PERIOD),
      new MatrixScroller(bushMesh, sBush, SCENERY_BACK, SCENERY_PERIOD)
    );

    g.add(oakMesh, oakTrunkMesh, pineMesh, pineTrunkMesh, bushMesh);
    return g;
  }

  /** Distant rolling green mountain ridges on the horizon. */
  private buildDistantMountains(): THREE.Group {
    const g = new THREE.Group();
    const mountainMat = new THREE.MeshStandardMaterial({
      color: 0x4a7c59,
      roughness: 0.95,
      metalness: 0.0
    });

    const mGeo = new THREE.ConeGeometry(80, 55, 7);

    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(mGeo, mountainMat);
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (180 + Math.random() * 120);
      const z = -400 - Math.random() * 400;
      const s = 1.2 + Math.random() * 0.8;
      m.scale.set(s, s * 0.75, s);
      m.position.set(x, 22 * s, z);
      g.add(m);
    }

    return g;
  }

  /** Majestic anime cumulus clouds along the horizon. */
  private buildSummerClouds(): THREE.Group {
    const g = this.cloudsGroup;
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0.0
    });

    const puffGeo = new THREE.SphereGeometry(1, 8, 8);

    for (let c = 0; c < 12; c++) {
      const cloud = new THREE.Group();
      const cx = (Math.random() - 0.5) * 650;
      const cy = 75 + Math.random() * 45;
      const cz = -250 - Math.random() * 350;

      const numPuffs = 8 + Math.floor(Math.random() * 8);
      for (let p = 0; p < numPuffs; p++) {
        const puff = new THREE.Mesh(puffGeo, cloudMat);
        const ps = 18 + Math.random() * 24;
        puff.scale.set(ps, ps * 0.75, ps);
        puff.position.set((Math.random() - 0.5) * 45, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 35);
        cloud.add(puff);
      }

      cloud.position.set(cx, cy, cz);
      g.add(cloud);
    }

    return g;
  }
}

/** MatrixScroller that preserves exact matrix scale/height while scrolling along Z. */
class MatrixScroller {
  private tempMat = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private rot = new THREE.Quaternion();
  private scale = new THREE.Vector3();

  constructor(
    private mesh: THREE.InstancedMesh,
    private instances: InstanceData[],
    private backZ: number,
    private period: number,
    private onRecycle?: (it: InstanceData, index: number) => void
  ) {}

  update(scroll: number): void {
    const mat = this.tempMat;
    const pos = this.pos;
    const rot = this.rot;
    const scale = this.scale;

    for (let i = 0; i < this.instances.length; i++) {
      const it = this.instances[i];
      it.z += scroll;
      if (it.z > this.backZ) {
        it.z -= this.period;
        if (this.onRecycle) {
          this.onRecycle(it, i);
          continue;
        }
      }
      this.mesh.getMatrixAt(i, mat);
      mat.decompose(pos, rot, scale);
      pos.z = it.z;
      mat.compose(pos, rot, scale);
      this.mesh.setMatrixAt(i, mat);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
