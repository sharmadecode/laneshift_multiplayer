import * as THREE from 'three';

export type VehicleType = 'hero_gt' | 'sedan' | 'suv' | 'hatchback' | 'van';

export interface CarMeshOptions {
  color: number;
  isPlayer?: boolean;
  type?: VehicleType;
}

/** Builds a high-fidelity, stylized vehicle mesh optimized for 60 FPS mobile rendering. Forward is -Z. */
export function createCarMesh(opts: CarMeshOptions): THREE.Group {
  const g = new THREE.Group();
  const type = opts.type ?? (opts.isPlayer ? 'hero_gt' : 'sedan');

  // Premium glossy PBR automotive paint with clearcoat (reflects the HDR sky environment)
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: opts.color,
    metalness: 0.68,
    roughness: 0.24,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08
  });

  // Dark tinted cabin glass with glossy specular reflections
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0f172a,
    metalness: 0.9,
    roughness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02
  });

  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1e222d, roughness: 0.8, metalness: 0.25 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.95, roughness: 0.12 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.35, roughness: 0.25 });
  const grilleMat = new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.9, metalness: 0.5 });

  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xf0f9ff,
    emissiveIntensity: 2.0
  });

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff1744,
    emissive: 0xff1744,
    emissiveIntensity: 2.4
  });

  const addBox = (
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0
  ): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (rx || ry || rz) m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // --- Silhouette Assembly by Vehicle Type ---
  if (type === 'hero_gt') {
    // === Hero GT Sports Coupe ===
    // Main lower body pan
    addBox(1.98, 0.36, 4.45, bodyMat, 0, 0.4, 0);

    // Sculpted sloping hood (-Z)
    addBox(1.88, 0.24, 1.35, bodyMat, 0, 0.54, -1.55, -0.09);

    // Front chin spoiler & air intake
    addBox(1.94, 0.14, 0.4, trimMat, 0, 0.24, -2.26);
    addBox(1.3, 0.18, 0.08, grilleMat, 0, 0.38, -2.26);

    // Rear deck & ducktail spoiler (+Z)
    addBox(1.88, 0.26, 1.25, bodyMat, 0, 0.62, 1.58, 0.06);
    addBox(1.92, 0.16, 0.4, trimMat, 0, 0.26, 2.24);

    // Cabin Cockpit & Windshields
    addBox(1.62, 0.48, 2.1, glassMat, 0, 0.92, -0.12, -0.05);
    // Roof panel
    addBox(1.54, 0.05, 1.75, bodyMat, 0, 1.18, -0.14);

    // Side air intakes / side skirts
    addBox(2.02, 0.1, 2.7, trimMat, 0, 0.24, 0);

    // Projector Headlights
    addBox(0.48, 0.12, 0.08, headMat, -0.66, 0.54, -2.25, 0, 0.14);
    addBox(0.48, 0.12, 0.08, headMat, 0.66, 0.54, -2.25, 0, -0.14);

    // Full-width continuous lightbar taillights
    addBox(1.74, 0.1, 0.08, tailMat, 0, 0.66, 2.24);

    // Side Mirrors
    addBox(0.24, 0.1, 0.16, bodyMat, -1.02, 0.8, -0.65, 0, 0.22);
    addBox(0.24, 0.1, 0.16, bodyMat, 1.02, 0.8, -0.65, 0, -0.22);

    // Dual Twin Chrome Exhaust Tips
    addBox(0.12, 0.1, 0.25, chromeMat, -0.55, 0.24, 2.3);
    addBox(0.12, 0.1, 0.25, chromeMat, 0.55, 0.24, 2.3);

    // GT Rear Wing
    addBox(1.78, 0.06, 0.36, bodyMat, 0, 1.06, 1.96, -0.07);
    addBox(0.08, 0.28, 0.12, trimMat, -0.74, 0.88, 1.94);
    addBox(0.08, 0.28, 0.12, trimMat, 0.74, 0.88, 1.94);
  } else if (type === 'suv') {
    // === SUV / Crossover ===
    addBox(2.06, 0.48, 4.6, bodyMat, 0, 0.56, 0);
    addBox(1.96, 0.3, 1.4, bodyMat, 0, 0.76, -1.58);
    addBox(2.02, 0.2, 0.45, trimMat, 0, 0.32, -2.32); // rugged bumper
    addBox(1.76, 0.64, 2.4, glassMat, 0, 1.18, 0.08);
    addBox(1.68, 0.06, 2.15, bodyMat, 0, 1.52, 0.05);

    // Roof Rails
    addBox(0.06, 0.08, 2.1, chromeMat, -0.78, 1.58, 0.05);
    addBox(0.06, 0.08, 2.1, chromeMat, 0.78, 1.58, 0.05);

    // Lights
    addBox(0.5, 0.16, 0.08, headMat, -0.7, 0.74, -2.32);
    addBox(0.5, 0.16, 0.08, headMat, 0.7, 0.74, -2.32);
    addBox(0.44, 0.22, 0.08, tailMat, -0.76, 0.94, 2.32);
    addBox(0.44, 0.22, 0.08, tailMat, 0.76, 0.94, 2.32);
  } else {
    // === Sedan / Commuter Car ===
    addBox(1.92, 0.4, 4.4, bodyMat, 0, 0.45, 0);
    addBox(1.84, 0.24, 1.3, bodyMat, 0, 0.6, -1.55, -0.06);
    addBox(1.84, 0.26, 1.1, bodyMat, 0, 0.66, 1.62, 0.04);
    addBox(1.64, 0.5, 2.1, glassMat, 0, 0.98, -0.05);
    addBox(1.56, 0.05, 1.8, bodyMat, 0, 1.25, -0.08);

    // Bumpers
    addBox(1.9, 0.14, 0.35, trimMat, 0, 0.26, -2.22);
    addBox(1.9, 0.14, 0.35, trimMat, 0, 0.26, 2.22);

    // Lights
    addBox(0.44, 0.14, 0.08, headMat, -0.66, 0.58, -2.22);
    addBox(0.44, 0.14, 0.08, headMat, 0.66, 0.58, -2.22);
    addBox(0.44, 0.14, 0.08, tailMat, -0.66, 0.68, 2.22);
    addBox(0.44, 0.14, 0.08, tailMat, 0.66, 0.68, 2.22);
  }

  // --- Wheel Assemblies (Tire, 5-Spoke Star Rim, Chrome Hub & Brake Disc) ---
  const tireRadius = type === 'suv' ? 0.38 : 0.34;
  const wheelY = type === 'suv' ? 0.38 : 0.34;
  const tireGeo = new THREE.CylinderGeometry(tireRadius, tireRadius, 0.26, 18);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181f, roughness: 0.92, metalness: 0.08 });

  const rimGeo = new THREE.CylinderGeometry(tireRadius * 0.72, tireRadius * 0.72, 0.27, 10);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.92, roughness: 0.18 });

  const hubGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.28, 8);
  hubGeo.rotateZ(Math.PI / 2);

  const brakeGeo = new THREE.CylinderGeometry(tireRadius * 0.62, tireRadius * 0.62, 0.06, 12);
  brakeGeo.rotateZ(Math.PI / 2);

  const wheels: THREE.Mesh[] = [];

  const wheelPositions: [number, number][] = [
    [-0.92, -1.42],
    [0.92, -1.42],
    [-0.92, 1.42],
    [0.92, 1.42]
  ];

  for (const [wx, wz] of wheelPositions) {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wheelY, wz);

    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.castShadow = true;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    const hub = new THREE.Mesh(hubGeo, chromeMat);

    wGroup.add(tire, rim, hub);
    g.add(wGroup);
    wheels.push(tire);

    const brake = new THREE.Mesh(brakeGeo, caliperMat);
    brake.position.set(wx > 0 ? wx - 0.08 : wx + 0.08, wheelY + 0.02, wz);
    g.add(brake);
  }

  // Soft Radial Contact Ambient Occlusion Shadow beneath car
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
  g.add(shadowMesh);

  g.userData.wheels = wheels;
  g.userData.bodyMaterial = bodyMat;
  return g;
}
