import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

// Color grade: desaturate, add contrast, split-tone (cool shadows, warm highlights),
// subtle chromatic aberration at the edges, vignette and film grain. Written for this project.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSaturation: { value: 0.8 },
    uContrast: { value: 1.12 },
    uShadowTint: { value: new THREE.Color(0.82, 0.9, 1.0) },
    uHighlightTint: { value: new THREE.Color(1.0, 0.9, 0.74) },
    uVignette: { value: 0.5 },
    uGrain: { value: 0.035 },
    uAberration: { value: 0.0018 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 dir = vUv - 0.5;
      float r = texture2D(tDiffuse, vUv + dir * uAberration).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - dir * uAberration).b;
      vec3 c = vec3(r, g, b);

      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(lum), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;

      float l = clamp(lum, 0.0, 1.0);
      c *= mix(uShadowTint, uHighlightTint, smoothstep(0.1, 0.9, l));

      float vig = 1.0 - uVignette * smoothstep(0.35, 0.95, length(dir) * 1.4);
      c *= vig;

      c += (rand(vUv * 1000.0 + uTime) - 0.5) * uGrain;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

// Post stack: scene -> bloom -> grade -> tone map / sRGB -> SMAA
export function createPostFx(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Ground-truth ambient occlusion: darkens corners, stair joins and crate contacts
  const gtao = new GTAOPass(scene, camera, size.x * pr, size.y * pr);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 0.9;
  composer.addPass(gtao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.4, 0.5, 0.9);
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  composer.addPass(new OutputPass());

  const smaa = new SMAAPass(size.x * pr, size.y * pr);
  composer.addPass(smaa);

  function resize(w, h) {
    const p = renderer.getPixelRatio();
    composer.setPixelRatio(p);
    composer.setSize(w, h);
    bloom.setSize(w * p, h * p);
    smaa.setSize(w * p, h * p);
    gtao.setSize(w * p, h * p);
  }

  return { composer, bloom, grade, gtao, resize };
}
