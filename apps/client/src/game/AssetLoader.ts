import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export class AssetLoader {
  private gltfLoader = new GLTFLoader();
  private dracoLoader = new DRACOLoader();
  private envMap: THREE.Texture | null = null;
  private heroCarTemplate: THREE.Group | null = null;
  private isLoaded = false;
  private loadCallbacks: (() => void)[] = [];

  constructor() {
    this.dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
  }

  /** Starts preloading all 3D assets. */
  async preload(): Promise<void> {
    try {
      const gltf = await this.gltfLoader.loadAsync('/models/ferrari.glb');
      const car = gltf.scene;

      // Extract and style Ferrari materials for rich daylight rendering
      const bodyMat = new THREE.MeshPhysicalMaterial({
        color: 0xeb3b5a,
        metalness: 0.72,
        roughness: 0.26,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08
      });

      const detailsMat = new THREE.MeshStandardMaterial({
        color: 0x1e222d,
        metalness: 0.85,
        roughness: 0.2
      });

      const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0x0f172a,
        metalness: 0.88,
        roughness: 0.04,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02
      });

      const wheelMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        metalness: 0.92,
        roughness: 0.15
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
          } else if (name.includes('wheel') || name.includes('rim')) {
            child.material = wheelMat;
            wheels.push(child);
          } else if (name.includes('trim') || name.includes('carbon') || name.includes('grille')) {
            child.material = detailsMat;
          }
        }
      });

      // Normalize size to standard car dimensions (~1.9m width, 4.4m length)
      const box = new THREE.Box3().setFromObject(car);
      const size = new THREE.Vector3();
      box.getSize(size);
      const targetLength = 4.4;
      const scale = targetLength / Math.max(size.x, size.z);
      car.scale.set(scale, scale, scale);

      // Re-center bounding box
      const center = new THREE.Vector3();
      box.getCenter(center);
      car.position.set(0, 0, 0);

      // Add contact ambient occlusion ground shadow
      const shadowCv = document.createElement('canvas');
      shadowCv.width = shadowCv.height = 128;
      const sCtx = shadowCv.getContext('2d')!;
      const rad = sCtx.createRadialGradient(64, 64, 8, 64, 64, 64);
      rad.addColorStop(0, 'rgba(0, 0, 0, 0.7)');
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
      this.isLoaded = true;
      for (const cb of this.loadCallbacks) cb();
      this.loadCallbacks = [];
      console.log('[AssetLoader] Hero sports car 3D model loaded successfully.');
    } catch (err) {
      console.warn('[AssetLoader] Error preloading GLB assets:', err);
    }
  }

  onReady(cb: () => void): void {
    if (this.isLoaded) cb();
    else this.loadCallbacks.push(cb);
  }

  /** Clones the loaded hero car or returns null if not ready yet. */
  createHeroCarInstance(color = 0xeb3b5a): THREE.Group | null {
    if (!this.heroCarTemplate) return null;
    const cloned = this.heroCarTemplate.clone(true);
    const bodyMat = (this.heroCarTemplate.userData.bodyMaterial as THREE.MeshPhysicalMaterial).clone();
    bodyMat.color.setHex(color);

    const wheels: THREE.Object3D[] = [];
    cloned.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (o.material === this.heroCarTemplate?.userData.bodyMaterial) {
          o.material = bodyMat;
        }
        const name = o.name.toLowerCase();
        if (name.includes('wheel') || name.includes('rim')) {
          wheels.push(o);
        }
      }
    });

    cloned.userData.bodyMaterial = bodyMat;
    cloned.userData.wheels = wheels;
    return cloned;
  }

  /** Generates a custom HDR Summer Afternoon environment map with golden sun and azure sky. */
  generateEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
    if (this.envMap) return this.envMap;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    const envScene = new THREE.Scene();

    const skyGeo = new THREE.SphereGeometry(100, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x3882d6) },
        bottomColor: { value: new THREE.Color(0xa7d8ff) },
        sunColor: { value: new THREE.Color(0xfff3d4) },
        sunDirection: { value: new THREE.Vector3(0.5, 0.75, -0.4).normalize() }
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform vec3 sunColor;
        uniform vec3 sunDirection;
        varying vec3 vWorldPosition;
        void main() {
          vec3 dir = normalize(vWorldPosition);
          float h = dir.y * 0.5 + 0.5;
          vec3 sky = mix(bottomColor, topColor, max(pow(h, 0.7), 0.0));
          float sun = max(dot(dir, sunDirection), 0.0);
          sky += sunColor * pow(sun, 64.0) * 2.5;
          gl_FragColor = vec4(sky, 1.0);
        }
      `
    });

    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    envScene.add(skyMesh);

    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.MeshBasicMaterial({ color: 0x569644 });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -1;
    envScene.add(groundMesh);

    const renderTarget = pmremGenerator.fromScene(envScene, 0.04);
    this.envMap = renderTarget.texture;

    pmremGenerator.dispose();
    skyGeo.dispose();
    skyMat.dispose();
    groundGeo.dispose();
    groundMat.dispose();

    return this.envMap;
  }
}

export const assetLoader = new AssetLoader();
