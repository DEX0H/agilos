import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadCharacter } from './models.js';

// First-person arms from the real character model (the same rigged human the bots use):
// only the forearms and hands are drawn, the hands wear dark tactical gloves, and each
// frame the arms are posed with two-bone IK so the hands sit exactly on the gun's grips
// and the fingers curl around them. Because the targets are attached to the gun, the
// hands follow every recoil kick, sway, bob, draw and reload.
//
// A grip target is an Object3D whose local +Y is the finger direction (wrist to
// knuckles, before curling) and +Z the palm normal (out of the palm, toward the grip).

const STAND_H = 1.8;
export const ARMS = { curlSign: 1 }; // which way the finger joints bend (rig convention)
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

// Quaternion of the basis (X = Y×Z, Y = f, Z = n), after making n perpendicular to f
export function basisQuat(f, n, out = new THREE.Quaternion()) {
  const y = _v1.copy(f).normalize();
  const z = _v2.copy(n).addScaledVector(y, -n.dot(y)).normalize();
  const x = _v3.crossVectors(y, z).normalize();
  return out.setFromRotationMatrix(_m.makeBasis(x, y, z));
}

// Which body part each vertex mostly belongs to, from its skin weights:
// 0 other (hidden), 1 right arm, 2 right hand, 3 left arm, 4 left hand
function partAttributes(geo, boneNames) {
  if (geo.attributes.aPart) return;
  const cat = boneNames.map((n) => {
    const side = n.endsWith('_r') ? 0 : n.endsWith('_l') ? 2 : -1;
    if (side < 0) return 0;
    if (/^(hand|index|middle|ring|pinky|thumb)/.test(n)) return side + 2;
    if (/^(lowerarm|upperarm)/.test(n)) return side + 1;
    return 0;
  });
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const n = si.count;
  const part = new Float32Array(n);
  const glove = new Float32Array(n);
  const sums = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    sums.fill(0);
    for (let k = 0; k < 4; k++) sums[cat[si.getComponent(i, k)]] += sw.getComponent(i, k);
    let best = 0;
    for (let c = 1; c < 5; c++) if (sums[c] > sums[best]) best = c;
    part[i] = best;
    glove[i] = sums[2] + sums[4];
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  geo.setAttribute('aGlove', new THREE.BufferAttribute(glove, 1));
}

// The body's own skin material, showing only one arm, with a glove over the hand
function armMaterial(base, side) {
  const m = base.clone();
  const keepA = side === 'r' ? 1 : 3;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nattribute float aGlove;\nvarying float vPart;\nvarying float vGlove;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = aPart;\nvGlove = aGlove;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart;\nvarying float vGlove;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (abs(vPart - ${keepA.toFixed(1)}) > 0.5 && abs(vPart - ${(keepA + 1).toFixed(1)}) > 0.5) discard;
        float gl = smoothstep(0.45, 0.75, vGlove);
        // Skin a touch warmer and less washed out; gloves dark grey fabric
        diffuseColor.rgb *= vec3(0.86, 0.76, 0.68);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.052, 0.055), gl);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(max(roughnessFactor, 0.55), 0.8, smoothstep(0.45, 0.75, vGlove));')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = 0.0;');
  };
  m.customProgramCacheKey = () => `fparm-${side}`;
  m.side = THREE.DoubleSide;
  return m;
}

class Arm {
  constructor(gltf, side, parent) {
    this.side = side;
    const model = SkeletonUtils.clone(gltf.scene);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    model.scale.setScalar(STAND_H / Math.max(0.01, box.max.y - box.min.y));
    model.rotation.y = Math.PI; // face -Z like the camera
    this.root = new THREE.Group();
    this.root.add(model);
    parent.add(this.root);
    this.model = model;

    let body = null;
    model.traverse((o) => {
      if (o.isSkinnedMesh && (!body || o.geometry.attributes.position.count > body.geometry.attributes.position.count)) body = o;
    });
    model.traverse((o) => { if (o.isMesh && o !== body) o.visible = false; });
    partAttributes(body.geometry, body.skeleton.bones.map((b) => b.name));
    body.material = armMaterial(body.material, side);
    body.frustumCulled = false;
    body.castShadow = false;
    body.renderOrder = 1;
    this.body = body;

    const bone = (n) => model.getObjectByName(`${n}_${side}`);
    this.upper = bone('upperarm');
    this.lower = bone('lowerarm');
    this.hand = bone('hand');
    this.fingers = FINGERS.map((f) => [1, 2, 3].map((k) => bone(`${f}_0${k}`)));
    this.thumb = [1, 2, 3].map((k) => bone(`thumb_0${k}`));
    const all = [this.upper, this.lower, this.hand, ...this.fingers.flat(), ...this.thumb];
    this.bind = new Map(all.map((b) => [b, b.quaternion.clone()]));

    // Hand frame in the hand bone's own space: finger direction and palm normal
    model.updateMatrixWorld(true);
    const f = this.fingers[1][0].position.clone().normalize();               // to the middle knuckle
    const across = this.fingers[0][0].position.clone().sub(this.fingers[3][0].position); // pinky -> index
    let n = new THREE.Vector3().crossVectors(across, f).normalize();
    // The palm faces the thumb's curl side: flip so it points away from the back of the hand
    const thumb = this.thumb[0].position.clone().normalize();
    if (n.dot(thumb) > 0.2) n.negate();
    // In the bind pose (arms out) the palms face down; trust that over the guess above
    const nWorld = n.clone().applyQuaternion(this.hand.getWorldQuaternion(new THREE.Quaternion()));
    if (nWorld.y > 0.3) n.negate();
    // The left hand is the mirror image, so the cross product above points the other way
    if (side === 'l') n.negate();
    this.handBasisInv = basisQuat(f, n).invert();

    // Curl axes for each finger joint, in that joint's own space (curling bends the finger
    // toward the palm side)
    const handQ = this.hand.getWorldQuaternion(new THREE.Quaternion());
    const nW = n.clone().applyQuaternion(handQ);
    this.curlAxes = new Map();
    for (const chain of [...this.fingers, this.thumb]) {
      for (const b of chain) {
        const child = b.children.find((c) => c.isBone) || null;
        const dirW = (child ? child.position.clone() : new THREE.Vector3(0, 1, 0)).applyQuaternion(b.getWorldQuaternion(_q1)).normalize();
        const axisW = new THREE.Vector3().crossVectors(dirW, nW).normalize();
        const axisL = axisW.applyQuaternion(_q1.invert());
        this.curlAxes.set(b, axisL.normalize());
      }
    }
  }

  // Put the shoulder at `shoulder` (camera space): the root moves, the body is hidden
  placeShoulder(shoulder) {
    this.root.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    const s = this.upper.getWorldPosition(_v1);
    this.root.parent.worldToLocal(s);
    this.root.position.copy(shoulder).sub(s);
    this.root.updateMatrixWorld(true);
  }

  // Rotate `bone` (world space) so the direction from it to `from` turns toward `to`
  aim(bone, from, to) {
    const p = bone.getWorldPosition(_v3);
    const a = _v1.copy(from).sub(p).normalize();
    const b = _v2.copy(to).sub(p).normalize();
    _q1.setFromUnitVectors(a, b);
    bone.getWorldQuaternion(_q2);
    _q2.premultiply(_q1);
    bone.parent.getWorldQuaternion(_q1).invert();
    bone.quaternion.copy(_q1.multiply(_q2));
    bone.updateMatrixWorld(true);
  }

  // target: grip Object3D; pole: elbow hint (camera space); curl: { fingers: [a,b,c] x4, thumb: [a,b,c] }
  solve(target, pole, curl) {
    for (const [b, q] of this.bind) b.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    const S = this.upper.getWorldPosition(new THREE.Vector3());
    const E0 = this.lower.getWorldPosition(new THREE.Vector3());
    const W0 = this.hand.getWorldPosition(new THREE.Vector3());
    const a = E0.distanceTo(S);
    const b = W0.distanceTo(E0);
    const T = target.getWorldPosition(new THREE.Vector3());
    // Out of reach (the viewmodel is compressed like every shooter's): the shoulder,
    // which is never on screen, moves toward the grip
    const over = T.distanceTo(S) - (a + b) * 0.96;
    if (over > 0) {
      const p0 = this.root.parent.worldToLocal(S.clone());
      const p1 = this.root.parent.worldToLocal(S.clone().addScaledVector(T.clone().sub(S).normalize(), over));
      this.root.position.add(p1.sub(p0));
      this.root.updateMatrixWorld(true);
      this.upper.getWorldPosition(S);
      this.lower.getWorldPosition(E0);
      this.hand.getWorldPosition(W0);
    }
    let d = T.distanceTo(S);
    const dir = T.clone().sub(S).normalize();
    d = THREE.MathUtils.clamp(d, Math.abs(a - b) + 1e-3, a + b - 1e-3);
    const P = pole.clone();
    this.root.parent.localToWorld(P);
    P.sub(S);
    const pv = P.addScaledVector(dir, -P.dot(dir)).normalize();
    const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const E = S.clone().addScaledVector(dir, a * cosA).addScaledVector(pv, a * Math.sqrt(1 - cosA * cosA));
    this.aim(this.upper, E0, E);
    this.aim(this.lower, this.hand.getWorldPosition(new THREE.Vector3()), T);
    // Hand orientation from the grip frame
    target.getWorldQuaternion(_q2).multiply(this.handBasisInv);
    this.lower.getWorldQuaternion(_q1).invert();
    this.hand.quaternion.copy(_q1.multiply(_q2));
    // Fingers
    for (let i = 0; i < 4; i++) {
      this.fingers[i].forEach((bn, k) => bn.quaternion.copy(this.bind.get(bn)).multiply(_q1.setFromAxisAngle(this.curlAxes.get(bn), ARMS.curlSign * curl.fingers[i][k])));
    }
    this.thumb.forEach((bn, k) => bn.quaternion.copy(this.bind.get(bn)).multiply(_q1.setFromAxisAngle(this.curlAxes.get(bn), ARMS.curlSign * curl.thumb[k])));
    this.root.updateMatrixWorld(true);
  }
}

export class FPArms {
  constructor(camera) {
    this.camera = camera;
    this.group = new THREE.Group();
    camera.add(this.group);
    this.right = null;
    this.left = null;
    this.ready = loadCharacter('male').then((g) => {
      this.right = new Arm(g, 'r', this.group);
      this.left = new Arm(g, 'l', this.group);
    }).catch((e) => console.warn('First-person arms failed to load', e));
  }

  // pose: { right: { target, shoulder, pole, curl }, left: {...} | null }
  update(pose, visible) {
    this.group.visible = !!(visible && this.right);
    if (!this.group.visible) return;
    for (const side of ['right', 'left']) {
      const arm = this[side];
      const p = pose[side];
      arm.root.visible = !!p;
      if (!p) continue;
      arm.placeShoulder(p.shoulder);
      arm.solve(p.target, p.pole, p.curl);
    }
  }
}
