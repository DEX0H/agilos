import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Shared model loading. Each model is fetched once; callers clone it.
//
// robot.glb: "RobotExpressive" by Tomás Laulhé (Quaternius), CC0 1.0,
// with expression morphs by Don McCurdy. See public/models/CREDITS.md.

const loader = new GLTFLoader();
const cache = new Map();

function load(file) {
  if (!cache.has(file)) {
    cache.set(file, loader.loadAsync(`${import.meta.env.BASE_URL}models/${file}`));
  }
  return cache.get(file);
}

export function loadRobot() {
  return load('robot.glb');
}
