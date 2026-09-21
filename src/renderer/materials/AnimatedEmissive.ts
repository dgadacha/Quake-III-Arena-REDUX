import { hdMaterials } from './HDMaterialLoader';
import * as THREE from 'three';
import type { ShaderSummary } from '../../formats/shader';
import type { TextureLibrary } from './TextureLibrary';

/** Les deux couches animMap des flammes se fondent l'une dans l'autre.
 * Les traiter comme une lampe PBR avec une onde sinus eteignait la flamme
 * une demi-periode sur deux et perdait son animation.
 */
export async function animatedEmissive(
  summary: ShaderSummary,
  textures: TextureLibrary,
  useHD = true,
): Promise<{ material: THREE.ShaderMaterial; update: (time: number) => void } | null> {
  if (!summary.additive || summary.animMaps.length < 2 || summary.animFrequency <= 0) return null;
  const loaded = await Promise.all(summary.animMaps.map(async (name) =>
    (useHD ? await hdMaterials.loadColor(name) : null) ?? (await textures.load(name))?.map ?? null));
  if (loaded.some((frame) => !frame)) return null;
  const frames = loaded as THREE.Texture[];
  const material = new THREE.ShaderMaterial({
    uniforms: {
      currentFrame: { value: frames[0] },
      nextFrame: { value: frames[1] },
      frameBlend: { value: 0 },
      intensity: { value: /flame/.test(summary.name) ? 6 : summary.surfaceLight > 0 ? 3.5 : 1.5 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D currentFrame;
      uniform sampler2D nextFrame;
      uniform float frameBlend;
      uniform float intensity;
      varying vec2 vUv;
      void main() {
        vec3 color = mix(texture2D(currentFrame, vUv).rgb,
                         texture2D(nextFrame, vUv).rgb, frameBlend);
        gl_FragColor = vec4(color * intensity, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: summary.twoSided ? THREE.DoubleSide : THREE.FrontSide,
    toneMapped: false,
  });
  return {
    material,
    update(time) {
      const frame = Math.max(0, time) * summary.animFrequency;
      const index = Math.floor(frame) % frames.length;
      material.uniforms.currentFrame.value = frames[index];
      material.uniforms.nextFrame.value = frames[(index + 1) % frames.length];
      material.uniforms.frameBlend.value = frame - Math.floor(frame);
    },
  };
}
