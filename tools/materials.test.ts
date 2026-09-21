import assert from 'node:assert/strict';
import * as THREE from 'three';
import { animatedEmissive } from '../src/renderer/materials/AnimatedEmissive';
import { subdivideLava } from '../src/bsp/liquidGeometry';
import { liquidTime } from '../src/renderer/materials/LiquidTime';
import { clearLiquids, updateLiquids } from '../src/renderer/materials/Q3Material';
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

const surfaceMap = new THREE.Texture();
const hd = {
  map: new THREE.Texture(), normalMap: new THREE.DataTexture(null, 2048, 1024),
  surfaceMap, emissiveMap: null,
  metalness: 0.9, normalStrength: 0.55, roughnessMultiplier: 1,
  entry: { type: 'metal', sourceSize: [256, 256] },
} as HDMaterialMaps;
const options = {
  metadata: classifySurface('textures/gothic_floor/q1metal7_99', null, 0, 0),
  texture: null, glow: null, lightMap: new THREE.Texture(), lightMapIntensity: Math.PI,
  vertexLit: false, vertexLightIntensity: 1, normalScale: 1, microDetail: 0,
};
const redux = createWorldMaterial({ ...options, hd });
const original = createWorldMaterial(options);
assert.ok(redux.normalScale.x > redux.normalScale.y);
assert.ok(redux.roughness < original.roughness);
assert.ok(redux.metalness <= 0.3);
/*
 * Une seule texture porte l'occlusion, la rugosite et le metal : Three lit un
 * canal par propriete, et les trois creneaux doivent donc pointer sur elle.
 */
assert.equal(redux.roughnessMap, surfaceMap);
assert.equal(redux.metalnessMap, surfaceMap);
assert.equal(redux.aoMap, surfaceMap);
assert.equal(original.aoMap, null);
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


/*
 * Micro-relief : il ne se pose que sur une surface qui a une normale a
 * incliner, et sa frequence suit la taille de la texture d'origine, pour que
 * le grain garde la meme echelle d'un mur a l'autre.
 */
const grained = createWorldMaterial({ ...options, hd, microDetail: 0.5 });
assert.ok(grained.customProgramCacheKey().includes('microDetail'));
const grainedShader = {
  uniforms: {},
  vertexShader: '#include <common>\n#include <project_vertex>',
  fragmentShader:
    '#include <common>\nvoid main() {\n#include <map_fragment>\n'
    + '#include <normal_fragment_maps>\n#include <lights_fragment_maps>\n}',
};
grained.onBeforeCompile(grainedShader as never, {} as THREE.WebGLRenderer);
assert.ok(grainedShader.fragmentShader.includes('microSlope'));
assert.ok((grainedShader.uniforms as { detailTiles: { value: number } }).detailTiles.value > 1);
assert.ok(!createWorldMaterial({ ...options, microDetail: 0.5 }).customProgramCacheKey().includes('microDetail'));
console.log('PASS micro relief: pose sur une normale, frequence tiree de la source');

/*
 * Lave : tout son mouvement vient du script du jeu. Les deux couches, leurs
 * echelles, leur teinte et le battement de leur opacite doivent traverser le
 * lecteur de scripts jusqu'au materiau.
 */
const lavaSummary = summarizeShader(parseShaderScript(`textures/liquids/lavahelldark
{
surfaceparm lava
cull disable
deformVertexes wave 1 sin 0.01 0.03 0 0.2
q3map_surfacelight 100
{
map textures/liquids/lavahell3.tga
tcMod scale 0.1 0.1
tcMod scroll -0.01 -0.01
}
{
map textures/liquids/lavahell3.tga
blendfunc add
rgbGen const ( 0.745098 0.321569 0.180392 )
tcMod scale -0.25 -0.25
alphaGen wave sin 0.5 0.5 0 0.1
}
}`)[0]);
assert.equal(lavaSummary.layers.length, 2);
assert.deepEqual(lavaSummary.layers[0].scale, [0.1, 0.1]);
assert.deepEqual(lavaSummary.layers[0].scroll, [-0.01, -0.01]);
assert.ok(lavaSummary.layers[1].additive);
assert.deepEqual(lavaSummary.layers[1].scale, [-0.25, -0.25]);
assert.equal(lavaSummary.layers[1].tint?.[0], 0.745098);
assert.equal(lavaSummary.layers[1].alphaWave?.frequency, 0.1);
assert.equal(lavaSummary.deformWave?.amplitude, 0.03);

const lavaMaterial = createWorldMaterial({
  ...options,
  metadata: classifySurface('textures/liquids/lavahelldark', lavaSummary, 0, 0),
  texture: { map: new THREE.Texture(), normalMap: null, roughnessMap: null, hasAlpha: false },
  microDetail: 0,
});
assert.ok(lavaMaterial.customProgramCacheKey().includes('lava'));
const lavaShader = {
  uniforms: {},
  vertexShader: '#include <common>\n#include <begin_vertex>',
  fragmentShader:
    '#include <common>\nvoid main() {\n#include <map_fragment>\n'
    + '#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n}',
};
lavaMaterial.onBeforeCompile(lavaShader as never, {} as THREE.WebGLRenderer);
const lavaUniforms = lavaShader.uniforms as Record<string, { value: { x: number } }>;
assert.deepEqual([lavaUniforms.lavaScale0.value.x, lavaUniforms.lavaScale1.value.x], [0.1, -0.25]);
assert.ok(Math.abs(lavaUniforms.lavaTint1.value.x - 0.745098) < 1e-6);
// Les fonctions lisent la texture : elles doivent venir apres sa declaration.
assert.ok(lavaShader.fragmentShader.indexOf('lavaLayer(vec2') < lavaShader.fragmentShader.indexOf('void main'));
assert.ok(lavaShader.fragmentShader.includes('totalEmissiveRadiance = lavaColor'));
console.log('PASS lave: deux couches, teinte et battement lus dans le script');

// Une transition de carte doit conserver l'horloge des materiaux deja charges.
clearLiquids();
updateLiquids(7.5);
assert.equal(lavaShader.uniforms.liquidTime, liquidTime);
assert.equal(liquidTime.value, 7.5);
const plane = new THREE.PlaneGeometry(256, 256);
const ranges = [{ face: 12, start: 0, count: 3 }, { face: 29, start: 3, count: 3 }];
subdivideLava(plane, ranges);
assert.equal(plane.index!.count, 6 * 64);
assert.deepEqual(ranges, [{ face: 12, start: 0, count: 192 }, { face: 29, start: 192, count: 192 }]);
assert.ok(plane.attributes.position.count > 4);
for (let i = 0; i < plane.attributes.position.count; i++) {
  assert.equal(plane.attributes.position.getZ(i), 0);
  assert.ok(Math.abs(plane.attributes.uv.getX(i) - (plane.attributes.position.getX(i) / 256 + 0.5)) < 1e-6);
}
console.log('PASS lave: horloge apres changement de carte, subdivision, UV et plages PVS');
