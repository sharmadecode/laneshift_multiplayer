import * as THREE from 'three';
import { LANE_COUNT, LANE_WIDTH, ROAD_HALF_WIDTH } from '@hr/shared';

const ROAD_HALF = ROAD_HALF_WIDTH;
const TILE_LEN = 96; // texture tile length (m)
const GROUND_LEN = 1110; // ground plane depth
const GROUND_CENTER = (8 - (GROUND_LEN - 8)) / 2;
const SCENERY_BACK = 30; // recycle objects when they pass this z
const SCENERY_PERIOD = 1050;

interface InstanceData {
  x: number;
  z: number;
  sy: number;
}

export interface RoadOptions {
  shadows: boolean;
  buildingsPerSide: number;
  lampsPerSide: number;
}

export class Road {
  readonly group = new THREE.Group();
  readonly moon: THREE.DirectionalLight;
  private groundTex!: THREE.CanvasTexture;
  private scrollers: Scroller[] = [];

  constructor(scene: THREE.Scene, opts: RoadOptions) {
    // --- fog + sky ---
    scene.background = new THREE.Color(0x05060f);
    scene.fog = new THREE.FogExp2(0x070912, 0.0095);

    // --- lights ---
    const hemi = new THREE.HemisphereLight(0x3a4a72, 0x05060a, 0.55);
    scene.add(hemi);

    this.moon = new THREE.DirectionalLight(0xaac4ff, 0.9);
    this.moon.position.set(40, 90, 30);
    this.moon.castShadow = opts.shadows;
    if (opts.shadows) {
      this.moon.shadow.mapSize.set(2048, 2048);
      this.moon.shadow.camera.near = 10;
      this.moon.shadow.camera.far = 300;
      this.moon.shadow.camera.left = -90;
      this.moon.shadow.camera.right = 90;
      this.moon.shadow.camera.top = 90;
      this.moon.shadow.camera.bottom = -90;
      this.moon.shadow.bias = -0.0006;
    }
    scene.add(this.moon);
    scene.add(this.moon.target);

    this.group.add(this.buildGround());
    this.group.add(this.buildGroundPlane());
    this.group.add(this.buildRails());
    this.group.add(this.buildLamps(opts.lampsPerSide));
    this.group.add(this.buildBuildings(opts.buildingsPerSide));
    scene.add(this.group);
  }

  /** Advance the scenery by scroll meters (world moves toward +Z). */
  update(scroll: number): void {
    for (const s of this.scrollers) s.update(scroll);
    this.groundTex.offset.y = (this.groundTex.offset.y + scroll / TILE_LEN) % 1;
  }

  setShadows(on: boolean): void {
    this.moon.castShadow = on;
  }

  private buildGround(): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 1024;
    const ctx = cv.getContext('2d')!;
    // asphalt base
    ctx.fillStyle = '#16171c';
    ctx.fillRect(0, 0, 512, 1024);
    for (let i = 0; i < 4200; i++) {
      const g = 14 + Math.floor(Math.random() * 26);
      ctx.fillStyle = `rgba(${g},${g},${g + 3},0.5)`;
      ctx.fillRect(Math.random() * 512, Math.random() * 1024, 2, 2);
    }
    // texture pixels per meter; x=0..512 maps to the full asphalt width
    const px = 512 / (ROAD_HALF * 2);
    const edge = ((LANE_COUNT * LANE_WIDTH) / 2) * px; // outer lane edges from center
    // darker shoulders between the edge lines and the asphalt edge
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, 256 - edge - 3, 1024);
    ctx.fillRect(256 + edge + 3, 0, 256 - edge - 3, 1024);
    // solid edge lines at the outer lane edges
    ctx.fillStyle = '#c9ccd4';
    ctx.fillRect(256 - edge - 3, 0, 6, 1024);
    ctx.fillRect(256 + edge - 3, 0, 6, 1024);
    // dashed separators between lanes
    ctx.fillStyle = '#cfd2da';
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
      roughness: 0.92,
      metalness: 0.05
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, GROUND_LEN), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, GROUND_CENTER);
    this.groundTex.repeat.set(1, GROUND_LEN / TILE_LEN);
    ground.receiveShadow = true;
    return ground;
  }

  /** Wide dark ground so the areas beside the asphalt are clearly not road. */
  private buildGroundPlane(): THREE.Mesh {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#0a0c13';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 500; i++) {
      const v = 12 + Math.random() * 14;
      ctx.fillStyle = `rgba(${v},${v},${v + 4},0.6)`;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(24, 44);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(260, GROUND_LEN),
      new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.06, GROUND_CENTER);
    ground.receiveShadow = true;
    return ground;
  }

  private buildRails(): THREE.Group {
    const g = new THREE.Group();
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.85 });
    const stripMat = new THREE.MeshStandardMaterial({
      color: 0x9fb4d8,
      emissive: 0x6f87b5,
      emissiveIntensity: 0.55,
      roughness: 0.4
    });
    const count = Math.ceil(SCENERY_PERIOD / 100);
    const concrete = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.85, 100), concreteMat, count * 2);
    const strip = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.07, 100), stripMat, count * 2);
    concrete.castShadow = true;
    strip.castShadow = true;

    const sConcrete: InstanceData[] = [];
    const sStrip: InstanceData[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        const z = -i * 100 - 10;
        const x = side * (ROAD_HALF + 1.1);
        sConcrete.push({ x, z: z + 0.4, sy: 1 });
        sStrip.push({ x, z, sy: 1 });
      }
    }
    this.scrollers.push(
      new Scroller(concrete, sConcrete, SCENERY_BACK, SCENERY_PERIOD),
      new Scroller(strip, sStrip, SCENERY_BACK, SCENERY_PERIOD)
    );
    g.add(concrete, strip);
    return g;
  }

  private buildLamps(perSide: number): THREE.Group {
    const g = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2f3542, roughness: 0.7, metalness: 0.6 });
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xffecc0,
      emissive: 0xffd98a,
      emissiveIntensity: 3.0
    });
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.1, 7.2, 6), poleMat, perSide * 2);
    const bulb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), bulbMat, perSide * 2);
    pole.castShadow = true;

    const sPole: InstanceData[] = [];
    const sBulb: InstanceData[] = [];
    const spacing = SCENERY_PERIOD / perSide;
    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const z = -i * spacing - 15;
        const x = side * (ROAD_HALF + 1.8);
        sPole.push({ x, z, sy: 1 });
        sBulb.push({ x: x - side * 0.2, z, sy: 1 });
      }
    }
    this.scrollers.push(
      new Scroller(pole, sPole, SCENERY_BACK, SCENERY_PERIOD),
      new Scroller(bulb, sBulb, SCENERY_BACK, SCENERY_PERIOD)
    );
    g.add(pole, bulb);
    return g;
  }

  private buildBuildings(perSide: number): THREE.Group {
    const g = new THREE.Group();

    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 256;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#0a0c15';
    ctx.fillRect(0, 0, 128, 256);
    const cols = 8;
    const rows = 18;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const wx = 4 + c * 15;
        const wy = 4 + r * 14;
        const lit = Math.random() < 0.42;
        if (lit) {
          const warm = Math.random() < 0.55;
          ctx.fillStyle = warm ? `rgba(255,214,150,${0.5 + Math.random() * 0.5})` : `rgba(160,200,255,${0.4 + Math.random() * 0.5})`;
        } else {
          ctx.fillStyle = '#1b2130';
        }
        ctx.fillRect(wx, wy, 7, 9);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;

    const buildingMat = new THREE.MeshStandardMaterial({
      map: tex,
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1
    });

    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMat, perSide * 2);
    mesh.castShadow = true;
    const instances: InstanceData[] = [];
    const spacing = SCENERY_PERIOD / perSide;
    for (const side of [-1, 1]) {
      for (let i = 0; i < perSide; i++) {
        const z = -i * spacing - 8 - Math.random() * 20;
        const x = side * (ROAD_HALF + 16 + Math.random() * 34);
        const h = 22 + Math.random() * 95;
        const w = 16 + Math.random() * 20;
        const d = 14 + Math.random() * 18;
        const it = { x, z, sy: 1 };
        instances.push(it);
        const index = instances.length - 1;
        this.applyBuildingMatrix(mesh, index, it, h, w, d);
        const tint = 0.55 + Math.random() * 0.45;
        mesh.setColorAt(index, new THREE.Color(tint, tint, tint));
      }
    }
    this.scrollers.push(new Scroller(mesh, instances, SCENERY_BACK, SCENERY_PERIOD, (it, i) => {
      const h = 22 + Math.random() * 95;
      const w = 16 + Math.random() * 20;
      const d = 14 + Math.random() * 18;
      this.applyBuildingMatrix(mesh, i, it, h, w, d);
    }));
    mesh.instanceColor!.needsUpdate = true;
    g.add(mesh);
    return g;
  }

  private applyBuildingMatrix(mesh: THREE.InstancedMesh, index: number, it: InstanceData, h: number, w: number, d: number): void {
    const m = new THREE.Matrix4();
    m.makeScale(w, h, d);
    m.setPosition(it.x, h / 2, it.z);
    mesh.setMatrixAt(index, m);
  }
}

/** Recycles instanced scenery: moves instances with the scroll and repositions when past the camera. */
class Scroller {
  private dummy = new THREE.Object3D();

  constructor(
    private mesh: THREE.InstancedMesh,
    private instances: InstanceData[],
    private backZ: number,
    private period: number,
    private onRecycle?: (it: InstanceData, index: number) => void
  ) {
    for (let i = 0; i < instances.length; i++) this.apply(i);
    mesh.instanceMatrix.needsUpdate = true;
  }

  update(scroll: number): void {
    const d = this.dummy;
    for (let i = 0; i < this.instances.length; i++) {
      const it = this.instances[i];
      it.z += scroll;
      if (it.z > this.backZ) {
        it.z -= this.period;
        if (this.onRecycle) this.onRecycle(it, i);
        this.apply(i);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private apply(i: number): void {
    const it = this.instances[i];
    const d = this.dummy;
    d.position.set(it.x, 0, it.z);
    d.scale.set(1, it.sy, 1);
    d.rotation.set(0, 0, 0);
    d.updateMatrix();
    this.mesh.setMatrixAt(i, d.matrix);
  }
}
