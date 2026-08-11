import * as THREE from 'three';

export interface CarMeshOptions {
  color: number;
  isPlayer?: boolean;
}

/** Builds a stylized procedural car. Forward = -Z. Returns a Group with userData.wheels. */
export function createCarMesh(opts: CarMeshOptions): THREE.Group {
  const g = new THREE.Group();

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: opts.color,
    metalness: 0.75,
    roughness: 0.32,
    clearcoat: 0.9,
    clearcoatRoughness: 0.18
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0b0e16,
    metalness: 0.9,
    roughness: 0.12
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.85 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.95 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xdfefff,
    emissive: 0xcfe9ff,
    emissiveIntensity: 2.4
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x3a0a10,
    emissive: 0xff2233,
    emissiveIntensity: 2.2
  });

  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  // lower body
  box(1.9, 0.42, 4.5, bodyMat, 0, 0.42, 0);
  // nose slope (front, -Z)
  box(1.82, 0.22, 0.7, bodyMat, 0, 0.62, -1.95);
  // rear deck
  box(1.88, 0.2, 0.8, bodyMat, 0, 0.68, 1.8);
  // cabin
  box(1.72, 0.44, 2.1, glassMat, 0, 0.95, -0.25);
  // bumpers
  box(1.92, 0.16, 0.3, darkMat, 0, 0.3, -2.22);
  box(1.92, 0.16, 0.3, darkMat, 0, 0.3, 2.22);
  // headlights
  box(0.42, 0.12, 0.08, headMat, -0.62, 0.62, -2.26);
  box(0.42, 0.12, 0.08, headMat, 0.62, 0.62, -2.26);
  // taillights
  box(0.5, 0.12, 0.06, tailMat, -0.6, 0.66, 2.25);
  box(0.5, 0.12, 0.06, tailMat, 0.6, 0.66, 2.25);

  if (opts.isPlayer) {
    // spoiler
    box(1.7, 0.06, 0.34, bodyMat, 0, 1.06, 1.85);
    box(0.1, 0.2, 0.1, darkMat, -0.75, 0.92, 1.85);
    box(0.1, 0.2, 0.1, darkMat, 0.75, 0.92, 1.85);
    // roof stripe
    box(1.74, 0.04, 2.12, darkMat, 0, 1.19, -0.25);
  }

  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14);
  wheelGeo.rotateY(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9, metalness: 0.4 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc7, metalness: 1, roughness: 0.25 });
  const wheels: THREE.Mesh[] = [];
  const hubGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.27, 10);
  hubGeo.rotateY(Math.PI / 2);
  for (const [wx, wz] of [
    [-0.85, -1.45],
    [0.85, -1.45],
    [-0.85, 1.45],
    [0.85, 1.45]
  ] as const) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(wx, 0.34, wz);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.set(wx, 0.34, wz);
    g.add(w);
    g.add(hub);
    wheels.push(w, hub);
  }

  g.userData.wheels = wheels;
  g.userData.bodyMaterial = bodyMat;
  void tireMat;
  return g;
}
