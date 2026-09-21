import assert from 'node:assert/strict';
import * as THREE from 'three';
import { animatedEmissive } from '../src/renderer/materials/AnimatedEmissive';
import { createWorldMaterial } from '../src/renderer/materials/Q3Material';
import { classifySurface } from '../src/renderer/materials/SurfaceMetadata';
import { MaterialComparison } from '../src/renderer/debug/MaterialViews';
import { parseShaderScript, summarizeShader } from '../src/formats/shader';
import { buildLightGridTextures } from '../src/bsp/LightGridTexture';
import type { TextureLibrary } from '../src/renderer/materials/TextureLibrary';
import type { HDMaterialMaps } from '../src/renderer/materials/HDMaterialLoader';
import type { BspMap } from '../src/formats/bsp';

const summary = summarizeShader(parseShaderScript(`textures/sfx/flame1side
{
cull none
{
animMap 10 flame1 flame2 flame3
blendFunc GL_ONE GL_ONE
}
}`)[0]);
const frames = [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()];
const library = {
  load: async (name: string) => ({ map: frames[Number(name.at(-1)) - 1] }),
} as unknown as TextureLibrary;
const animated = (await animatedEmissive(summary, library))!;
assert.ok(animated);
animated.update(0.15);
assert.equal(animated.material.uniforms.currentFrame.value, frames[1]);
assert.equal(animated.material.uniforms.nextFrame.value, frames[2]);
assert.ok(Math.abs(animated.material.uniforms.frameBlend.value - 0.5) < 1e-6);
animated.update(0.275);
assert.equal(animated.material.uniforms.nextFrame.value, frames[0]);
assert.equal(animated.material.uniforms.intensity.value, 6);
assert.equal(animated.material.depthWrite, false);
assert.equal(animated.material.side, THREE.DoubleSide);
assert.equal(await animatedEmissive({ ...summary, additive: false }, library), null);
console.log('PASS animated flames: blending, wraparound, continuous emission, additive depth');

const hd = {
  map: new THREE.Texture(), normalMap: new THREE.DataTexture(null, 2048, 1024),
  roughnessMap: new THREE.Texture(), metalnessMap: null, aoMap: null, emissiveMap: null,
  metalness: 0.9, normalStrength: 0.55, roughnessMultiplier: 1,
  entry: { type: 'metal' },
} as HDMaterialMaps;
const options = {
  metadata: classifySurface('textures/gothic_floor/q1metal7_99', null, 0, 0),
  texture: null, glow: null, lightMap: new THREE.Texture(), lightMapIntensity: Math.PI,
  vertexLit: false, vertexLightIntensity: 1, normalScale: 1,
};
const redux = createWorldMaterial({ ...options, hd });
const original = createWorldMaterial(options);
assert.ok(redux.normalScale.x > redux.normalScale.y);
assert.ok(redux.roughness < original.roughness);
assert.ok(redux.metalness <= 0.3);
const compile = redux.onBeforeCompile;
const key = redux.customProgramCacheKey();
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), redux);
mesh.userData.materials = { original, redux };
const root = new THREE.Group();
root.add(mesh);
const comparison = new MaterialComparison();
comparison.attach(root);
comparison.setMode('split');
const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <project_vertex>',
  fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n#include <lights_fragment_maps>\n}' };
redux.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
assert.ok(shader.fragmentShader.includes('surfaceSaturation'));
assert.ok(shader.fragmentShader.includes('uSplit'));
assert.ok(shader.fragmentShader.includes('q3LightmapLift'));
comparison.setMode('redux');
assert.equal(redux.onBeforeCompile, compile);
assert.equal(redux.customProgramCacheKey(), key);
assert.equal(mesh.children.length, 0);
console.log('PASS material tuning and split comparison preserve the lighting shaders');

const grid = buildLightGridTextures({ lightVolumes: {
  counts: [2, 1, 1], mins: [64, 128, 0],
  ambient: new Uint8Array([100, 100, 100, 0, 0, 0]),
  directional: new Uint8Array([200, 150, 100, 0, 0, 0]),
  direction: new Uint8Array([0, 0, 0, 0]),
} } as unknown as BspMap)!;
assert.deepEqual(grid.mins.toArray(), [32, 96, -64]);
assert.equal(grid.direction.minFilter, THREE.LinearFilter);
assert.deepEqual([...grid.direction.image.data.slice(4, 7)], [128, 128, 128]);
grid.dispose();
console.log('PASS light grid: aligned texel centers, continuous directions, neutral solid cells');
