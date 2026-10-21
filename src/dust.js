import * as THREE from 'three';

// Floating dust motes catching the low sun. They bloom slightly and add depth.
export function createDust(scene, count = 500) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 60;
    pos[i * 3 + 1] = Math.random() * 12;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: new THREE.Color(1.6, 1.3, 0.9),
    size: 0.05,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geom, mat);
  scene.add(points);

  return {
    update(t) {
      points.rotation.y = t * 0.015;
      points.position.y = Math.sin(t * 0.3) * 0.25;
    },
  };
}
