import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export interface TrafficCarTemplate {
  scene: THREE.Group;
  wheels: THREE.Object3D[];
  bodyMeshes: THREE.Mesh[];
}

export class AssetLoader {
  private gltfLoader = new GLTFLoader();
  private dracoLoader = new DRACOLoader();
  private envMap: THREE.Texture | null = null;
  private heroCarTemplate: THREE.Group | null = null;

  // Traffic Vehicle Templates (7 unique models)
  readonly trafficTemplates: TrafficCarTemplate[] = [];

  // Scenery Model Pools (All 69 assets from allassetsglb)
  readonly towers: THREE.Group[] = [];
  readonly houses: THREE.Group[] = [];
  readonly shops: THREE.Group[] = [];
  readonly trees: THREE.Group[] = [];
  readonly streetlamps: THREE.Group[] = [];
  readonly trafficLights: THREE.Group[] = [];
  readonly pastoralProps: THREE.Group[] = [];
  readonly railwayCars: THREE.Group[] = [];

  private isLoaded = false;
  private loadCallbacks: (() => void)[] = [];

  constructor() {
    this.dracoLoader.setDecoderPath('/draco/');
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
  }

  /** Starts preloading all 3D assets. */
  async preload(): Promise<void> {
    try {
      // 1. Hero Ferrari GLB
      const gltfFerrari = await this.gltfLoader.loadAsync('/models/ferrari.glb');
      const car = gltfFerrari.scene;

      const bodyMat = new THREE.MeshPhysicalMaterial({
        color: 0xeb3b5a,
        metalness: 0.72,
        roughness: 0.26,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        envMapIntensity: 0.65
      });

      const detailsMat = new THREE.MeshStandardMaterial({
        color: 0x1e222d,
        metalness: 0.85,
        roughness: 0.2,
        envMapIntensity: 0.5
      });

      const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0x0f172a,
        metalness: 0.88,
        roughness: 0.04,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        envMapIntensity: 0.9
      });

      const wheelMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        metalness: 0.92,
        roughness: 0.15,
        envMapIntensity: 0.4
      });

      const wheels: THREE.Object3D[] = [];

      car.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          const name = child.name.toLowerCase();
          if (name.includes('body')) {
            child.material = bodyMat;
          } else if (name.includes('glass')) {
            child.material = glassMat;
          } else if ((name.includes('wheel') || name.includes('rim')) && !name.startsWith('steering')) {
            child.material = wheelMat;
          } else if (name.includes('trim') || name.includes('carbon') || name.includes('grille') || name.includes('grill')) {
            child.material = detailsMat;
          }
        }

        const name = child.name.toLowerCase();
        if (name.startsWith('wheel_')) wheels.push(child);
      });

      if (!wheels.length) {
        car.traverse((child) => {
          const name = child.name.toLowerCase();
          if ((name.includes('wheel') || name.includes('rim')) && !name.startsWith('steering')) wheels.push(child);
        });
      }

      this.reorientToGameFrame(car, wheels);

      const box = new THREE.Box3().setFromObject(car);
      const size = new THREE.Vector3();
      box.getSize(size);
      const targetLength = 4.4;
      const scale = targetLength / Math.max(size.x, size.z);
      car.scale.set(scale, scale, scale);
      car.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(car);
      if (box2.min.y < 0) car.position.y -= box2.min.y;

      // Contact shadow
      const shadowCv = document.createElement('canvas');
      shadowCv.width = shadowCv.height = 128;
      const sCtx = shadowCv.getContext('2d')!;
      const rad = sCtx.createRadialGradient(64, 64, 8, 64, 64, 64);
      rad.addColorStop(0, 'rgba(0, 0, 0, 0.75)');
      rad.addColorStop(0.6, 'rgba(0, 0, 0, 0.35)');
      rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      sCtx.fillStyle = rad;
      sCtx.fillRect(0, 0, 128, 128);

      const shadowTex = new THREE.CanvasTexture(shadowCv);
      const shadowMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2.5, 5.0),
        new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.85, depthWrite: false })
      );
      shadowMesh.rotation.x = -Math.PI / 2;
      shadowMesh.position.set(0, 0.02, 0);
      car.add(shadowMesh);

      car.userData.wheels = wheels;
      car.userData.bodyMaterial = bodyMat;
      this.heroCarTemplate = car;

      // 2. Preload Traffic Vehicles (18 distinct curated models)
      const trafficModelPaths = [
        { path: '/models/Nissan-GTR.glb', length: 4.65 },
        { path: '/models/quaternius-sports-car.glb', length: 4.5 },
        { path: '/models/police-car.glb', length: 4.6 },
        { path: '/models/Mazda-RX-7.glb', length: 4.35 },
        { path: '/models/2015-Dodge-Challenger.glb', length: 4.85 },
        { path: '/models/1994-Nissan-180MX.glb', length: 4.45 },
        { path: '/models/white-sports-convertible.glb', length: 4.4 },
        { path: '/models/toyota-ae86.glb', length: 4.3 },
        { path: '/models/ignition-car.glb', length: 4.5 },
        { path: '/models/1972-Bursley-Defiance.glb', length: 4.8 },
        { path: '/models/Ambulance.glb', length: 5.2 },
        { path: '/models/car-sedan-01.glb', length: 4.5 },
        { path: '/models/family-sedan.glb', length: 4.6 },
        { path: '/models/pastel-sedan.glb', length: 4.5 },
        { path: '/models/metropolis-taxi-01.glb', length: 4.5 },
        { path: '/models/taxi-01.glb', length: 4.4 },
        { path: '/models/Mitsubishi-L200.glb', length: 5.1 },
        { path: '/models/quaternius-suv.glb', length: 4.8 }
      ];

      for (const item of trafficModelPaths) {
        try {
          const gltf = await this.gltfLoader.loadAsync(item.path);
          const tModel = this.normalizeModel(gltf.scene, item.length, true);
          const bodyMeshes: THREE.Mesh[] = [];
          const tWheels: THREE.Object3D[] = [];

          tModel.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.castShadow = true;
              o.receiveShadow = true;
              const name = o.name.toLowerCase();
              if (name.includes('body') || name.includes('car') || name.includes('paint') || name.includes('chassis')) {
                bodyMeshes.push(o);
              }
              if (name.includes('wheel') || name.includes('rim') || name.includes('tire')) {
                tWheels.push(o);
              }
            }
          });

          this.trafficTemplates.push({
            scene: tModel,
            wheels: tWheels,
            bodyMeshes
          });
        } catch {
          // Graceful fallback
        }
      }

      // 3. Preload Highrises, Modern City Towers & Skyline Landmarks (35m - 150m heights)
      const towerPaths = [
        { path: '/models/glass-skyscraper-01.glb', height: 110 },
        { path: '/models/glass-supertall-01.glb', height: 145 },
        { path: '/models/Skyscraper.glb', height: 120 },
        { path: '/models/Skyscraper-BwEXdOoUSO.glb', height: 130 },
        { path: '/models/Skyscraper-jIRx0AhYOR.glb', height: 115 },
        { path: '/models/Skyscraper-obYD8hWLTZ.glb', height: 125 },
        { path: '/models/Skyscraper-PsPe0MzK0E.glb', height: 140 },
        { path: '/models/Skyscraper-XST1j6kYsL.glb', height: 135 },
        { path: '/models/Large-Building.glb', height: 85 },
        { path: '/models/Large-Building-1bt4yYKmuK.glb', height: 80 },
        { path: '/models/Large-Building-3IhrYZp6tP.glb', height: 75 },
        { path: '/models/Large-Building-h7Jaq7bqMq.glb', height: 90 },
        { path: '/models/Large-Building-JgGLJH2iXj.glb', height: 85 },
        { path: '/models/Large-Building-ppwtREejXg.glb', height: 95 },
        { path: '/models/Large-Building-sxXonOmtct.glb', height: 80 },
        { path: '/models/TIME-HOTEL-2.10.glb', height: 70 },
        { path: '/models/Hotel-Building.glb', height: 60 },
        { path: '/models/Hospital.glb', height: 55 },
        { path: '/models/midrise-office-01.glb', height: 65 },
        { path: '/models/waterfront-condo-tower.glb', height: 85 },
        { path: '/models/apartment-block-01.glb', height: 50 },
        { path: '/models/Apartment-building.glb', height: 48 },
        { path: '/models/deco-apartment-walkup.glb', height: 38 },
        { path: '/models/deco-hotel-three-bay.glb', height: 55 },
        { path: '/models/Ferris-wheel.glb', height: 45 },
        { path: '/models/Helicopter.glb', height: 12 }
      ];
      for (const t of towerPaths) {
        try {
          const g = await this.gltfLoader.loadAsync(t.path);
          this.towers.push(this.normalizeBuilding(g.scene, t.height));
        } catch {
          // Skip
        }
      }

      // 4. Preload Suburban Houses & Residential Villas (12m - 18m heights)
      const housePaths = [
        { path: '/models/Two-story-house-9N6ROCbmO1.glb', height: 16.5 },
        { path: '/models/Two-story-house-hmXhiLDf8D.glb', height: 16.0 },
        { path: '/models/Two-story-house-htvFgnVP4d.glb', height: 16.5 },
        { path: '/models/Two-story-house-QsF9E0PqyN.glb', height: 15.5 },
        { path: '/models/Two-story-house-sGgL4Nt7I7.glb', height: 16.0 },
        { path: '/models/House-with-driveway.glb', height: 15.0 },
        { path: '/models/Town-House.glb', height: 17.0 },
        { path: '/models/House.glb', height: 14.5 },
        { path: '/models/House-7VSVwAg2T3.glb', height: 15.0 },
        { path: '/models/two-story-house.glb', height: 16.5 },
        { path: '/models/bungalow-house.glb', height: 13.5 },
        { path: '/models/ranch-house.glb', height: 13.0 },
        { path: '/models/home-cottage-01.glb', height: 14.0 },
        { path: '/models/home-thatched-house-01.glb', height: 13.5 },
        { path: '/models/farmhouse.glb', height: 16.0 },
        { path: '/models/garage.glb', height: 9.5 }
      ];
      for (const h of housePaths) {
        try {
          const g = await this.gltfLoader.loadAsync(h.path);
          this.houses.push(this.normalizeBuilding(g.scene, h.height));
        } catch {
          // Skip
        }
      }

      // 5. Preload Commercial Stores, Strip Malls & Race Grandstands (10m - 18m heights)
      const shopPaths = [
        { path: '/models/Low-Building.glb', height: 14.0 },
        { path: '/models/Low-Building-4RoPd9BkSx.glb', height: 14.5 },
        { path: '/models/Low-Building-9fEKMpTsAi.glb', height: 13.5 },
        { path: '/models/Low-Building-AXFdNPAEc9.glb', height: 14.0 },
        { path: '/models/Low-Building-dYEbYdPfJr.glb', height: 15.0 },
        { path: '/models/Low-Building-sObKC8Mio2.glb', height: 14.0 },
        { path: '/models/Low-Building-tuieC1Pj0a.glb', height: 14.5 },
        { path: '/models/Low-Building-XsFOzw8E5N.glb', height: 13.5 },
        { path: '/models/Low-Building-zfjlejAxB7.glb', height: 14.0 },
        { path: '/models/Low-Wide.glb', height: 15.0 },
        { path: '/models/Low-Wide-DKgknsHjmr.glb', height: 15.5 },
        { path: '/models/Small-Building.glb', height: 12.5 },
        { path: '/models/Small-Building-gyjF60t7CG.glb', height: 13.0 },
        { path: '/models/Small-Building-QjL4Fo9dU9.glb', height: 12.0 },
        { path: '/models/Small-Building-Rq572hdKEz.glb', height: 13.0 },
        { path: '/models/Small-Building-t9j9Lof5ul.glb', height: 12.5 },
        { path: '/models/Small-Building-yLvnMqC9ZG.glb', height: 13.0 },
        { path: '/models/Low-Poly-Sports-Stands.glb', height: 14.0 },
        { path: '/models/Market-Stand.glb', height: 8.5 },
        { path: '/models/Gazebo.glb', height: 9.0 },
        { path: '/models/convenience-store-01.glb', height: 14.0 },
        { path: '/models/corner-store-01.glb', height: 15.5 },
        { path: '/models/bld-general-store-01.glb', height: 14.5 },
        { path: '/models/general-store.glb', height: 15.5 },
        { path: '/models/deco-shopfront-row.glb', height: 16.0 },
        { path: '/models/shop-awning-01.glb', height: 12.0 }
      ];
      for (const s of shopPaths) {
        try {
          const g = await this.gltfLoader.loadAsync(s.path);
          this.shops.push(this.normalizeBuilding(g.scene, s.height));
        } catch {
          // Skip
        }
      }

      // 6. Preload 3D Trees & Foliage (12m - 24m lush canopies)
      const treePaths = [
        { path: '/models/Birch-Tree.glb', height: 18.0 },
        { path: '/models/Pine-Tree.glb', height: 22.0 },
        { path: '/models/Simple-Tree.glb', height: 17.0 },
        { path: '/models/Stylized-Tree.glb', height: 16.0 },
        { path: '/models/Trees.glb', height: 20.0 },
        { path: '/models/tree-oak-01.glb', height: 18.0 },
        { path: '/models/lineside-oak.glb', height: 17.0 },
        { path: '/models/lineside-pine.glb', height: 21.0 },
        { path: '/models/cypress-tree.glb', height: 22.0 },
        { path: '/models/date-palm.glb', height: 19.0 },
        { path: '/models/apple-tree.glb', height: 14.0 },
        { path: '/models/arborvitae-conifer.glb', height: 15.0 },
        { path: '/models/metropolis-street-tree-01.glb', height: 14.0 },
        { path: '/models/bush-round-01.glb', height: 5.5 },
        { path: '/models/Flower-Bushes.glb', height: 4.5 },
        { path: '/models/Rocks.glb', height: 4.5 }
      ];
      for (const tr of treePaths) {
        try {
          const g = await this.gltfLoader.loadAsync(tr.path);
          this.trees.push(this.normalizeBuilding(g.scene, tr.height));
        } catch {
          // Skip
        }
      }

      // 7. Preload Street Lamps, Highway Gantries, Billboards & Safety Equipment
      const lampPaths = [
        { path: '/models/streetlamp-01.glb', height: 9.5 },
        { path: '/models/streetlamp.glb', height: 8.8 },
        { path: '/models/traffic-light-01.glb', height: 8.2 },
        { path: '/models/Traffic-light.glb', height: 8.0 },
        { path: '/models/Traffic-light-Q6k7Izx6YD.glb', height: 8.2 },
        { path: '/models/Billboard.glb', height: 16.0 },
        { path: '/models/Bus-stop-sign.glb', height: 6.5 },
        { path: '/models/Stop-sign.glb', height: 5.5 },
        { path: '/models/Bike-Warning-Road-Sign.glb', height: 5.5 },
        { path: '/models/Bench.glb', height: 3.0 },
        { path: '/models/Concrete-Barrier.glb', height: 3.5 },
        { path: '/models/Barrier-Large.glb', height: 4.0 },
        { path: '/models/Race-Flag.glb', height: 10.0 }
      ];
      for (const p of lampPaths) {
        try {
          const g = await this.gltfLoader.loadAsync(p.path);
          if (p.path.includes('streetlamp')) {
            this.streetlamps.push(this.normalizeBuilding(g.scene, p.height));
          } else {
            this.trafficLights.push(this.normalizeBuilding(g.scene, p.height));
          }
        } catch {
          // Skip
        }
      }

      // 8. Preload Farmsteads, Countryside Mills, Windmills, Silos & Pastoral Details
      const pastoralPaths = [
        { path: '/models/Barn.glb', height: 18.0 },
        { path: '/models/Big-Barn.glb', height: 21.0 },
        { path: '/models/Open-Barn.glb', height: 16.0 },
        { path: '/models/Small-Barn.glb', height: 14.0 },
        { path: '/models/big-red-barn.glb', height: 18.5 },
        { path: '/models/Silo.glb', height: 24.0 },
        { path: '/models/Silo-House.glb', height: 22.0 },
        { path: '/models/Mill.glb', height: 20.0 },
        { path: '/models/Tower-Windmill.glb', height: 26.0 },
        { path: '/models/Well.glb', height: 5.0 },
        { path: '/models/Hay.glb', height: 3.5 },
        { path: '/models/Fence-Long.glb', height: 3.0 },
        { path: '/models/Fence.glb', height: 3.0 },
        { path: '/models/sheep.glb', height: 2.2 },
        { path: '/models/chicken.glb', height: 1.2 },
        { path: '/models/chicken-coop.glb', height: 4.5 },
        { path: '/models/signal-box.glb', height: 9.5 },
        { path: '/models/crossing-keeper-hut.glb', height: 7.0 },
        { path: '/models/goods-shed.glb', height: 9.0 },
        { path: '/models/bait-shack.glb', height: 8.5 },
        { path: '/models/boat-house.glb', height: 10.0 },
        { path: '/models/pastel-lifeguard-tower.glb', height: 9.5 },
        { path: '/models/outhouse-privy.glb', height: 5.5 },
        { path: '/models/coaling-tower-modern.glb', height: 24.0 }
      ];
      for (const p of pastoralPaths) {
        try {
          const g = await this.gltfLoader.loadAsync(p.path);
          this.pastoralProps.push(this.normalizeBuilding(g.scene, p.height));
        } catch {
          // Skip
        }
      }

      // 9. Preload Countryside Railway Trains & Wagons
      const railwayPaths = [
        { path: '/models/diesel-locomotive.glb', height: 7.5 },
        { path: '/models/loco-tender.glb', height: 6.5 },
        { path: '/models/passenger-coach.glb', height: 7.0 },
        { path: '/models/mail-coach.glb', height: 7.0 },
        { path: '/models/freight-van.glb', height: 6.8 },
        { path: '/models/flatbed-wagon.glb', height: 4.5 },
        { path: '/models/open-coal-wagon.glb', height: 5.2 },
        { path: '/models/cattle-wagon.glb', height: 6.5 },
        { path: '/models/container-flat-wagon.glb', height: 6.2 }
      ];
      for (const r of railwayPaths) {
        try {
          const g = await this.gltfLoader.loadAsync(r.path);
          this.railwayCars.push(this.normalizeBuilding(g.scene, r.height));
        } catch {
          // Skip
        }
      }

      this.isLoaded = true;
      for (const cb of this.loadCallbacks) cb();
      this.loadCallbacks = [];
      console.log(`[AssetLoader] Successfully preloaded 18-car traffic fleet, ${this.towers.length} towers, ${this.houses.length} houses, ${this.shops.length} commercial stores, ${this.trees.length} trees, ${this.streetlamps.length} lamps, ${this.pastoralProps.length} pastoral landmarks, ${this.railwayCars.length} train wagons.`);
    } catch (err) {
      console.warn('[AssetLoader] Error preloading GLB assets:', err);
    }
  }

  private normalizeModel(scene: THREE.Group, targetLength: number, addShadow = false): THREE.Group {
    const root = new THREE.Group();
    root.add(scene);
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    scene.position.x -= center.x;
    scene.position.z -= center.z;
    scene.position.y -= box.min.y;

    const maxHoriz = Math.max(size.x, size.z);
    if (maxHoriz > 0) {
      const s = targetLength / maxHoriz;
      root.scale.set(s, s, s);
    }

    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    if (addShadow) {
      const shadowCv = document.createElement('canvas');
      shadowCv.width = shadowCv.height = 128;
      const sCtx = shadowCv.getContext('2d')!;
      const rad = sCtx.createRadialGradient(64, 64, 8, 64, 64, 64);
      rad.addColorStop(0, 'rgba(0, 0, 0, 0.75)');
      rad.addColorStop(0.6, 'rgba(0, 0, 0, 0.35)');
      rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      sCtx.fillStyle = rad;
      sCtx.fillRect(0, 0, 128, 128);

      const shadowTex = new THREE.CanvasTexture(shadowCv);
      const shadowMat = new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.85
      });
      const shadowGeo = new THREE.PlaneGeometry(2.4, 5.0);
      const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
      shadowMesh.rotation.x = -Math.PI / 2;
      shadowMesh.position.set(0, 0.02, 0);
      root.add(shadowMesh);
    }

    return root;
  }

  private normalizeBuilding(scene: THREE.Group, targetHeight: number, maxFootprint = 18): THREE.Group {
    const root = new THREE.Group();
    root.add(scene);
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const currentHeight = Math.max(size.y, 0.001);
    let scale = targetHeight / currentHeight;
    // Strictly cap maximum width and depth so models never spill outside their boundary
    if (size.x * scale > maxFootprint) {
      scale = maxFootprint / size.x;
    }
    if (size.z * scale > maxFootprint * 1.5) {
      scale = (maxFootprint * 1.5) / size.z;
    }

    scene.scale.set(scale, scale, scale);
    scene.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    root.updateMatrixWorld(true);

    root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    return root;
  }

  private reorientToGameFrame(car: THREE.Group, wheels: THREE.Object3D[]): void {
    car.updateMatrixWorld(true);

    const wheelYs = wheels.map((w) => {
      const p = new THREE.Vector3();
      w.getWorldPosition(p);
      return p.y;
    });
    const y0 = wheelYs[0] ?? 0;
    if (wheels.length < 4 || wheelYs.some((y) => Math.abs(y - y0) > 0.5)) {
      return;
    }

    let bodyMesh: THREE.Object3D | null = null;
    car.traverse((child) => {
      if (!bodyMesh && child instanceof THREE.Mesh && child.name.toLowerCase().includes('body')) bodyMesh = child;
    });
    if (!bodyMesh) return;

    let bodyNode: THREE.Object3D = bodyMesh;
    while (bodyNode.parent && bodyNode.parent !== car) bodyNode = bodyNode.parent;
    bodyNode.quaternion.setFromAxisAngle(new THREE.Vector3(0, -1, 0), Math.PI / 2);
    car.updateMatrixWorld(true);

    let front: THREE.Object3D | null = null;
    let rear: THREE.Object3D | null = null;
    car.traverse((child) => {
      const name = child.name.toLowerCase();
      if (!front && (name.includes('grill') || name.includes('lights')) && !name.includes('lights_red')) front = child;
      if (!rear && name.includes('lights_red')) rear = child;
    });
    if (front && rear) {
      const f = front as THREE.Object3D;
      const r = rear as THREE.Object3D;
      const nose = new THREE.Vector3();
      f.getWorldPosition(nose);
      const rp = new THREE.Vector3();
      r.getWorldPosition(rp);
      nose.sub(rp);
      nose.y = 0;
      if (nose.z > 0) {
        car.rotation.y = Math.PI;
        car.updateMatrixWorld(true);
      }
    }
  }

  onReady(cb: () => void): void {
    if (this.isLoaded) cb();
    else this.loadCallbacks.push(cb);
  }

  createHeroCarInstance(color = 0xeb3b5a): THREE.Group | null {
    if (!this.heroCarTemplate) return null;
    const cloned = this.heroCarTemplate.clone(true);
    cloned.rotation.y = Math.PI / 2;

    const bodyMat = (this.heroCarTemplate.userData.bodyMaterial as THREE.MeshPhysicalMaterial).clone();
    bodyMat.color.setHex(color);

    const wheels: THREE.Object3D[] = [];
    cloned.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (o.material === this.heroCarTemplate?.userData.bodyMaterial) {
          o.material = bodyMat;
        }
      }
      const name = o.name.toLowerCase();
      if (name.startsWith('wheel_')) wheels.push(o);
    });
    if (!wheels.length) {
      cloned.traverse((o) => {
        const name = o.name.toLowerCase();
        if ((name.includes('wheel') || name.includes('rim')) && !name.startsWith('steering')) wheels.push(o);
      });
    }

    cloned.userData.bodyMaterial = bodyMat;
    cloned.userData.wheels = wheels;
    return cloned;
  }

  /** Clones a traffic car model using its 100% original unmodified model textures and colors. */
  createTrafficCarInstance(modelIndex: number): THREE.Group | null {
    if (!this.trafficTemplates.length) return null;
    const tmpl = this.trafficTemplates[modelIndex % this.trafficTemplates.length];
    if (!tmpl) return null;
    const cloned = tmpl.scene.clone(true);
    // Rotate 180 degrees so front faces forward (-Z direction) down the highway
    cloned.rotation.y = Math.PI;
    return cloned;
  }
}

export const assetLoader = new AssetLoader();
