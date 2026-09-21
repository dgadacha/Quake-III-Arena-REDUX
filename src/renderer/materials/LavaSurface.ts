import * as THREE from 'three';
import { liquidTime } from './LiquidTime';
import { lavaPattern } from './LavaPattern';
import type { SurfaceLayer } from '../../formats/shader';
import type { SurfaceMetadata } from './SurfaceMetadata';

/** Lave animee : couches Q3, croute periodique, fissures emissives et houle. */

/** Ce que le rendu retient d'une couche du script. */
interface Layer {
  scale: [number, number];
  scroll: [number, number];
  turb: [number, number, number, number];
  tint: [number, number, number];
  /** base, amplitude, phase, frequence de l'onde d'opacite. */
  wave: [number, number, number, number];
  additive: boolean;
}

/** Couches par defaut, quand le script ne dit rien : la lave d'origine. */
const FALLBACK: SurfaceLayer[] = [
  { texture: '', additive: false, scale: [0.1, 0.1], scroll: [-0.01, -0.01], turb: null, tint: null, alphaWave: null },
  {
    texture: '',
    additive: true,
    scale: [-0.25, -0.25],
    scroll: [-0.01, -0.01],
    turb: null,
    tint: [0.745, 0.322, 0.18],
    alphaWave: { base: 0.5, amplitude: 0.5, phase: 0, frequency: 0.1 },
  },
];

export interface LavaSurface {
  uniforms: Record<string, { value: number }>;
  apply: (shader: THREE.WebGLProgramParametersWithUniforms) => void;
  key: string;
}

/**
 * Prepare une surface de lave d'apres ce que son script declare. La matiere
 * elle-meme est reglee ici : une lave est opaque, mate par endroits, et ne
 * reflete presque rien.
 */
export function lavaSurface(
  material: THREE.MeshStandardMaterial,
  metadata: SurfaceMetadata,
  glow: number,
): LavaSurface {
  // Une lave est visqueuse : elle a un reflet large, pas un miroir.
  material.roughness = 0.62;
  material.metalness = 0;
  material.envMapIntensity = 0.08;
  material.normalMap = material.roughnessMap = material.metalnessMap = material.aoMap = material.emissiveMap = null;

  const declared = metadata.layers.filter((layer) => layer.texture);
  const layers = (declared.length >= 2 ? declared : FALLBACK).slice(0, 2).map(read);
  // Une seule couche declaree : la seconde est deduite de la premiere, a
  // l'echelle inversee, ce que fait le script quand il en a deux.
  if (layers.length === 1) layers.push({ ...layers[0], scale: [-2.5, -2.5], additive: true, tint: [0.75, 0.32, 0.18] });

  const uniforms: Record<string, { value: number }> = {
    liquidTime,
    lavaGlow: { value: glow },
  };

  // La pente suit la houle ; le maillage BSP est subdivise uniquement pour la lave.
  const wave = metadata.deformWave;
  const swell: [number, number, number] = wave
    ? [wave.division || 1, wave.amplitude, wave.frequency]
    : [64, 2, 0.15];

  return {
    uniforms,
    key: 'lava',
    apply(shader) {
      shader.uniforms.liquidTime = uniforms.liquidTime;
      shader.uniforms.lavaPattern = { value: lavaPattern() };
      shader.uniforms.lavaGlow = uniforms.lavaGlow;
      shader.uniforms.lavaSwell = { value: new THREE.Vector3(...swell) };
      for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];
        shader.uniforms[`lavaScale${index}`] = { value: new THREE.Vector2(...layer.scale) };
        shader.uniforms[`lavaScroll${index}`] = { value: new THREE.Vector2(...layer.scroll) };
        shader.uniforms[`lavaTurb${index}`] = { value: new THREE.Vector4(...layer.turb) };
        shader.uniforms[`lavaTint${index}`] = { value: new THREE.Vector3(...layer.tint) };
        shader.uniforms[`lavaWave${index}`] = { value: new THREE.Vector4(...layer.wave) };
      }

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
        varying vec3 vLavaPosition;
        uniform float liquidTime;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLavaPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        // Le BSP utilise Z pour la verticale. Les parois restent immobiles.
        float surfaceWave = sin(vLavaPosition.x * 0.024 + liquidTime * 0.7)
          * sin(vLavaPosition.y * 0.019 - liquidTime * 0.46);
        transformed.z += surfaceWave * 1.8 * smoothstep(0.6, 0.95, abs(normal.z));`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
        varying vec3 vLavaPosition;
        uniform float liquidTime;
        uniform float lavaGlow;
        uniform sampler2D lavaPattern;
        uniform vec3 lavaSwell;
        uniform vec2 lavaScale0;
        uniform vec2 lavaScroll0;
        uniform vec4 lavaTurb0;
        uniform vec3 lavaTint0;
        uniform vec4 lavaWave0;
        uniform vec2 lavaScale1;
        uniform vec2 lavaScroll1;
        uniform vec4 lavaTurb1;
        uniform vec3 lavaTint1;
        uniform vec4 lavaWave1;`)
        .replace('void main() {', `        /*
         * Turbulence des coordonnees, comme le jeu la calcule : la phase vient
         * de la position dans le monde, divisee par mille vingt-quatre, et non
         * des coordonnees de texture. Deux faces voisines restent donc
         * d'accord sur le mouvement.
         */
        vec2 lavaTurbulence(vec2 uv, vec4 turb) {
          float now = turb.z + liquidTime * turb.w;
          float alongX = (vLavaPosition.x + vLavaPosition.z) / 1024.0 + now;
          float alongY = vLavaPosition.y / 1024.0 + now;
          return uv + vec2(sin(alongX * 6.2831853), sin(alongY * 6.2831853)) * turb.y;
        }

        vec4 lavaLayer(vec2 uv, vec2 scale, vec2 scroll, vec4 turb, vec3 tint, vec4 wave) {
          vec2 moved = lavaTurbulence(uv * scale + scroll * liquidTime, turb);
          vec4 sampled = texture2D(map, moved);
          float pulse = wave.x + wave.y * sin((wave.z + liquidTime * wave.w) * 6.2831853);
          return vec4(sampled.rgb * tint, clamp(pulse, 0.0, 1.0));
        }
        void main() {`)
        .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 lavaCrust = lavaLayer(vMapUv, lavaScale0, lavaScroll0, lavaTurb0, lavaTint0, lavaWave0);
        vec4 lavaVeins = lavaLayer(vMapUv, lavaScale1, lavaScroll1, lavaTurb1, lavaTint1, lavaWave1);
        // La seconde couche s'ajoute, comme le script le demande, et son
        // opacite la fait respirer.
        vec3 lavaColor = lavaCrust.rgb + lavaVeins.rgb * lavaVeins.a;
        vec2 crustUv = vLavaPosition.xy / 420.0 + vec2(-0.007, 0.004) * liquidTime;
        vec4 flow = texture2D(lavaPattern, crustUv * 0.57 + vec2(0.003, -0.005) * liquidTime);
        vec4 crust = texture2D(lavaPattern, crustUv + vec2(sin(flow.r * 6.283), cos(flow.r * 4.1)) * 0.075);
        vec4 detail = texture2D(lavaPattern, crustUv * 3.73 - vec2(0.002, 0.003) * liquidTime);
        float molten = 1.0 - smoothstep(0.16, 0.65, crust.r + (detail.r - 0.5) * 0.18);
        float pulse = 0.88 + 0.12 * sin(liquidTime * 0.85 + flow.r * 6.283);
        vec3 moltenColor = mix(vec3(0.7, 0.025, 0.001), vec3(1.0, 0.19, 0.008), pow(molten, 3.0));
        lavaColor = mix(vec3(0.026, 0.012, 0.007) + lavaColor * 0.12, moltenColor, molten);
        diffuseColor.rgb = lavaColor;`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        /*
         * Houle lente : l'onde que le script declare, portee par la normale.
         * Sa longueur est celle de la division, sa cadence celle de sa
         * frequence, et elle suffit a faire glisser les reflets.
         */
        float lavaSwellPhase = dot(vLavaPosition, vec3(1.0)) / max(lavaSwell.x, 1.0)
          + liquidTime * lavaSwell.z;
        vec2 lavaSlope = vec2(
          cos(lavaSwellPhase * 6.2831853),
          cos(lavaSwellPhase * 6.2831853 + 1.5707963)
        ) * lavaSwell.y * 0.012;
        normal = normalize(normal + mat3(viewMatrix) * vec3((crust.gb - 0.5) * 1.7 + lavaSlope, 0.0));`)
        .replace('#include <opaque_fragment>', `
        // La chaleur propre domine : aucun reflet blanc de lampe sur le magma.
        float crustShade = 0.6 + 0.4 * max(0.0, dot(normal, normalize(vec3(0.3, 0.4, 1.0))));
        outgoingLight = diffuseColor.rgb * 0.5 * crustShade + totalEmissiveRadiance;
        #include <opaque_fragment>`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.92, 0.38, molten);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        /*
         * La chaleur n'est pas repartie : la croute sombre ne brille pas, les
         * veines si. C'est cette difference qui remplace l'aplat, et c'est
         * elle que le halo lumineux reprend.
         */
        totalEmissiveRadiance = lavaColor * clamp(lavaGlow, 1.4, 2.0) * (molten * 0.94 + 0.06) * pulse;`);
    },
  };
}

/** Valeurs d'une couche, avec les defauts du jeu quand le script se taît. */
function read(layer: SurfaceLayer): Layer {
  return {
    scale: layer.scale,
    scroll: layer.scroll,
    turb: layer.turb
      ? [layer.turb.base, layer.turb.amplitude, layer.turb.phase, layer.turb.frequency]
      : [0, 0.02, 0, 0.05],
    tint: layer.tint ?? [1, 1, 1],
    wave: layer.alphaWave
      ? [layer.alphaWave.base, layer.alphaWave.amplitude, layer.alphaWave.phase, layer.alphaWave.frequency]
      : [1, 0, 0, 0],
    additive: layer.additive,
  };
}
