import * as THREE from 'three';

// Low golden-hour sun. Shared by the sky shader, the sun light and the shadows.
export const SUN_DIR = new THREE.Vector3(20, 40, 10).normalize();

// Gradient sky dome with a sun disc and glow. Written for this project.
// It follows the camera, so it always looks infinitely far away.
export function createSky(scene) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x3d6a9e) },
      uHorizon: { value: new THREE.Color(0xf0b07a) },
      uGround: { value: new THREE.Color(0x1d1a18) },
      uSunDir: { value: SUN_DIR },
      uSunColor: { value: new THREE.Color(1.0, 0.75, 0.45) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
        vec3 col = h < 0.0 ? mix(uHorizon * 0.6, uGround, smoothstep(0.0, -0.25, h)) : sky;
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * (pow(s, 12.0) * 0.35 + pow(s, 400.0) * 4.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}
