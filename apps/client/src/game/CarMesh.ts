import * as THREE from 'three';

export type VehicleType = 'hero_gt' | 'sedan' | 'suv' | 'hatchback' | 'van';

export interface CarMeshOptions {
  color: number;
  isPlayer?: boolean;
  type?: VehicleType;
}

/** Builds high-fidelity, sleek automotive meshes with PBR materials and realistic proportions. Forward is -Z. */
export function createCarMesh(opts: CarMeshOptions): THREE.Group {
  const g = new THREE.Group();
  const type = opts.type ?? (opts.isPlayer ? 'hero_gt' : 'sedan');

  // Premium glossy PBR automotive paint with clearcoat (reflects the HDR sky environment)
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: opts.color,
    metalness: 0.65,
    roughness: 0.22,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    envMapIntensity: 0.75
  });

  // Dark tinted cabin glass with glossy specular reflections
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a0f1d,
    metalness: 0.92,
    roughness: 0.04,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    envMapIntensity: 0.95
  });

  const trimMat = new THREE.MeshStandardMaterial({ color: 0x181a20, roughness: 0.85, metalness: 0.2 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, metalness: 0.96, roughness: 0.1, envMapIntensity: 0.9 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.4, roughness: 0.25 });
  const grilleMat = new THREE.MeshStandardMaterial({ color: 0x0f1117, roughness: 0.95, metalness: 0.4 });

  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xf0f9ff,
    emissiveIntensity: 2.2
  });

  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff1744,
    emissive: 0xff1744,
    emissiveIntensity: 2.5
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
    addBox(1.98, 0.36, 4.45, bodyMat, 0, 0.4, 0);
    addBox(1.88, 0.24, 1.35, bodyMat, 0, 0.54, -1.55, -0.09);
    addBox(1.94, 0.14, 0.4, trimMat, 0, 0.24, -2.26);
    addBox(1.3, 0.18, 0.08, grilleMat, 0, 0.38, -2.26);
    addBox(1.88, 0.26, 1.25, bodyMat, 0, 0.62, 1.58, 0.06);
    addBox(1.92, 0.16, 0.4, trimMat, 0, 0.26, 2.24);

    // Cabin Cockpit & Windshields
    addBox(1.62, 0.48, 2.1, glassMat, 0, 0.92, -0.12, -0.05);
    addBox(1.54, 0.05, 1.75, bodyMat, 0, 1.18, -0.14);
    addBox(2.02, 0.1, 2.7, trimMat, 0, 0.24, 0);

    // Lights
    addBox(0.48, 0.12, 0.08, headMat, -0.66, 0.54, -2.25, 0, 0.14);
    addBox(0.48, 0.12, 0.08, headMat, 0.66, 0.54, -2.25, 0, -0.14);
    addBox(1.74, 0.1, 0.08, tailMat, 0, 0.66, 2.24);

    // Mirrors & Exhaust
    addBox(0.24, 0.1, 0.16, bodyMat, -1.02, 0.8, -0.65, 0, 0.22);
    addBox(0.24, 0.1, 0.16, bodyMat, 1.02, 0.8, -0.65, 0, -0.22);
    addBox(0.12, 0.1, 0.25, chromeMat, -0.55, 0.24, 2.3);
    addBox(0.12, 0.1, 0.25, chromeMat, 0.55, 0.24, 2.3);

    // GT Wing
    addBox(1.78, 0.06, 0.36, bodyMat, 0, 1.06, 1.96, -0.07);
    addBox(0.08, 0.28, 0.12, trimMat, -0.74, 0.88, 1.94);
    addBox(0.08, 0.28, 0.12, trimMat, 0.74, 0.88, 1.94);

  } else if (type === 'suv') {
    // === Luxury Performance SUV ===
    addBox(2.04, 0.46, 4.65, bodyMat, 0, 0.54, 0);
    // Sloped Hood
    addBox(1.94, 0.32, 1.45, bodyMat, 0, 0.76, -1.58, -0.06);
    // Lower Diffuser & Grille
    addBox(2.0, 0.18, 0.45, trimMat, 0, 0.28, -2.34);
    addBox(1.4, 0.22, 0.06, grilleMat, 0, 0.46, -2.35);
    // Cabin with Raked Windscreen & Floating Roof
    addBox(1.76, 0.62, 2.45, glassMat, 0, 1.16, 0.06, -0.04);
    addBox(1.68, 0.05, 2.2, bodyMat, 0, 1.49, 0.06);
    // Roof Spoiler & Chrome Rails
    addBox(1.68, 0.06, 0.35, bodyMat, 0, 1.49, 1.25);
    addBox(0.05, 0.06, 2.0, chromeMat, -0.76, 1.54, 0.05);
    addBox(0.05, 0.06, 2.0, chromeMat, 0.76, 1.54, 0.05);
    // Dual Projector LED Headlights
    addBox(0.48, 0.14, 0.08, headMat, -0.7, 0.72, -2.34, 0, 0.12);
    addBox(0.48, 0.14, 0.08, headMat, 0.7, 0.72, -2.34, 0, -0.12);
    // Sleek Split Tail-light Bars
    addBox(0.52, 0.12, 0.08, tailMat, -0.72, 0.88, 2.34);
    addBox(0.52, 0.12, 0.08, tailMat, 0.72, 0.88, 2.34);
    // Dual Exhaust
    addBox(0.16, 0.08, 0.2, chromeMat, -0.65, 0.28, 2.35);
    addBox(0.16, 0.08, 0.2, chromeMat, 0.65, 0.28, 2.35);

  } else if (type === 'hatchback') {
    // === Sporty Hot Hatchback ===
    addBox(1.88, 0.38, 4.15, bodyMat, 0, 0.46, 0);
    // Short Aggressive Hood
    addBox(1.8, 0.26, 1.25, bodyMat, 0, 0.62, -1.42, -0.09);
    addBox(1.84, 0.14, 0.35, trimMat, 0, 0.26, -2.08);
    addBox(1.2, 0.16, 0.06, grilleMat, 0, 0.42, -2.1);
    // Glasshouse
    addBox(1.62, 0.52, 2.05, glassMat, 0, 0.98, 0.02, -0.06);
    addBox(1.54, 0.05, 1.85, bodyMat, 0, 1.26, 0.02);
    // Roof Spoiler Wing
    addBox(1.56, 0.05, 0.38, bodyMat, 0, 1.28, 1.15, -0.08);
    // Lights
    addBox(0.42, 0.12, 0.08, headMat, -0.64, 0.6, -2.1, 0, 0.12);
    addBox(0.42, 0.12, 0.08, headMat, 0.64, 0.6, -2.1, 0, -0.12);
    addBox(0.46, 0.14, 0.08, tailMat, -0.66, 0.82, 2.1);
    addBox(0.46, 0.14, 0.08, tailMat, 0.66, 0.82, 2.1);
    // Center Dual Exhaust
    addBox(0.24, 0.08, 0.2, chromeMat, 0, 0.24, 2.12);

  } else if (type === 'van') {
    // === European Commercial Van ===
    addBox(2.06, 1.25, 4.9, bodyMat, 0, 1.0, 0.15);
    addBox(1.96, 0.44, 1.1, bodyMat, 0, 0.64, -1.95, -0.08);
    addBox(1.85, 0.58, 1.1, glassMat, 0, 1.16, -1.35, -0.08);
    addBox(2.02, 0.2, 0.4, trimMat, 0, 0.28, -2.48);
    addBox(2.02, 0.2, 0.4, trimMat, 0, 0.28, 2.58);
    // Vertical Commercial Tail Lamps
    addBox(0.14, 0.72, 0.06, tailMat, -0.92, 1.1, 2.62);
    addBox(0.14, 0.72, 0.06, tailMat, 0.92, 1.1, 2.62);
    // Headlights
    addBox(0.46, 0.18, 0.08, headMat, -0.74, 0.7, -2.5, 0, 0.08);
    addBox(0.46, 0.18, 0.08, headMat, 0.74, 0.7, -2.5, 0, -0.08);

  } else {
    // === Executive Sports Sedan ===
    addBox(1.92, 0.38, 4.5, bodyMat, 0, 0.46, 0);
    // Long Swept Hood
    addBox(1.84, 0.25, 1.45, bodyMat, 0, 0.62, -1.52, -0.07);
    addBox(1.88, 0.14, 0.38, trimMat, 0, 0.25, -2.28);
    addBox(1.3, 0.16, 0.06, grilleMat, 0, 0.44, -2.3);
    // Fastback Glass Cabin
    addBox(1.64, 0.5, 2.25, glassMat, 0, 0.98, -0.05, -0.04);
    addBox(1.56, 0.05, 1.9, bodyMat, 0, 1.25, -0.06);
    // Rear Trunk Deck
    addBox(1.84, 0.26, 0.8, bodyMat, 0, 0.68, 1.82, 0.03);
    addBox(1.88, 0.14, 0.38, trimMat, 0, 0.25, 2.28);
    // Projector Headlights
    addBox(0.45, 0.12, 0.08, headMat, -0.66, 0.6, -2.3, 0, 0.12);
    addBox(0.45, 0.12, 0.08, headMat, 0.66, 0.6, -2.3, 0, -0.12);
    // Full-Width LED Tail Bar
    addBox(1.72, 0.1, 0.08, tailMat, 0, 0.72, 2.28);
    // Side Mirrors
    addBox(0.22, 0.09, 0.14, bodyMat, -0.98, 0.82, -0.65, 0, 0.2);
    addBox(0.22, 0.09, 0.14, bodyMat, 0.98, 0.82, -0.65, 0, -0.2);
    // Dual Chrome Exhaust
    addBox(0.14, 0.08, 0.22, chromeMat, -0.58, 0.24, 2.32);
    addBox(0.14, 0.08, 0.22, chromeMat, 0.58, 0.24, 2.32);
  }

  // --- Wheel Assemblies (Tire, 5-Spoke Star Rim, Chrome Hub & Brake Disc) ---
  const tireRadius = type === 'suv' ? 0.37 : type === 'van' ? 0.36 : 0.33;
  const wheelY = tireRadius;
  const tireGeo = new THREE.CylinderGeometry(tireRadius, tireRadius, 0.24, 18);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9, metalness: 0.1 });

  const rimGeo = new THREE.CylinderGeometry(tireRadius * 0.74, tireRadius * 0.74, 0.25, 10);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xa0aec0, metalness: 0.94, roughness: 0.15 });

  const hubGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.26, 8);
  hubGeo.rotateZ(Math.PI / 2);

  const brakeGeo = new THREE.CylinderGeometry(tireRadius * 0.6, tireRadius * 0.6, 0.05, 12);
  brakeGeo.rotateZ(Math.PI / 2);

  const wheels: THREE.Object3D[] = [];

  const wheelPositions: [number, number][] = [
    [-0.92, -1.42],
    [0.92, -1.42],
    [-0.92, 1.42],
    [0.92, 1.42]
  ];

  for (const [wx, wz] of wheelPositions) {
    const wGroup = new THREE.Group();
    wGroup.position.set(wx, wheelY, wz);

    const spin = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.castShadow = true;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    const hub = new THREE.Mesh(hubGeo, chromeMat);

    spin.add(tire, rim, hub);
    wGroup.add(spin);
    g.add(wGroup);
    wheels.push(spin);

    const brake = new THREE.Mesh(brakeGeo, caliperMat);
    brake.position.set(wx > 0 ? wx - 0.07 : wx + 0.07, wheelY + 0.02, wz);
    g.add(brake);
  }

  // Soft Radial Contact Ambient Occlusion Shadow beneath car
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
    new THREE.PlaneGeometry(2.5, 5.2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.85, depthWrite: false })
  );
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.set(0, 0.02, 0);
  g.add(shadowMesh);

  g.userData.wheels = wheels;
  g.userData.bodyMaterial = bodyMat;
  return g;
}
