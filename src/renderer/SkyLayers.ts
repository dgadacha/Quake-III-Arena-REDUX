import { hdMaterials } from './materials/HDMaterialLoader';
import * as THREE from 'three';
import type { ShaderDefinition } from '../formats/shader';
import type { TextureLibrary } from './materials/TextureLibrary';

/**
 * Ciel en couches de nuages. Une carte declare son ciel de deux facons : six
 * images formant une boite, ou, quand la premiere valeur de skyparms vaut un
 * tiret, une ou deux couches de nuages projetees a une hauteur donnee.
 *
 * Ces couches se plaquent sur les faces de ciel de la carte, avec des
 * coordonnees calculees depuis la direction du regard : c'est ce qui donne
 * l'impression d'un ciel lointain et non d'une texture collee sur un mur.
 */

export interface SkyLayerMaterialOptions {
  definition: ShaderDefinition;
  textures: TextureLibrary;
  /** Hauteur des nuages declaree par la carte. */
  cloudHeight: number;
  useHD?: boolean;
}

interface LayerData {
  map: THREE.Texture;
  scale: THREE.Vector2;
  scroll: THREE.Vector2;
}

/**
 * Dome place autour du joueur, habille du meme materiau que les faces de ciel.
 * Il remplit les directions ou la carte n'a pas de face de ciel, sans jamais
 * masquer le decor puisqu'il n'ecrit pas la profondeur et passe en premier.
 */
export function createSkyDome(material: THREE.ShaderMaterial): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(1, 32, 16);
  const dome = new THREE.Mesh(geometry, material.clone());
  (dome.material as THREE.ShaderMaterial).uniforms = material.uniforms;
  (dome.material as THREE.ShaderMaterial).side = THREE.BackSide;
  (dome.material as THREE.ShaderMaterial).depthWrite = false;
  dome.scale.setScalar(9000);
  dome.frustumCulled = false;
  dome.renderOrder = -1001;
  dome.name = 'skydome';
  return dome;
}

/** Cree le materiau des faces de ciel, ou rien si aucune couche n'est lisible. */
export async function createSkyLayerMaterial(
  options: SkyLayerMaterialOptions,
): Promise<THREE.ShaderMaterial | null> {
  const layers: LayerData[] = [];

  for (const stage of options.definition.stages) {
    if (!stage.map || stage.map.startsWith('$')) continue;
    const map = (options.useHD !== false ? await hdMaterials.loadColor(stage.map) : null)
      ?? (await options.textures.load(stage.map))?.map;
    if (!map) continue;

    const scale = new THREE.Vector2(1, 1);
    const scroll = new THREE.Vector2(0, 0);
    for (const mod of stage.tcMods) {
      const parts = mod.split(/\s+/);
      if (parts[0] === 'scale') {
        scale.set(Number(parts[1]) || 1, Number(parts[2]) || 1);
      } else if (parts[0] === 'scroll') {
        scroll.set(Number(parts[1]) || 0, Number(parts[2]) || 0);
      }
    }

    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.needsUpdate = true;
    layers.push({ map, scale, scroll });
    if (layers.length === 2) break;
  }

  if (layers.length === 0) return null;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      layerOne: { value: layers[0].map },
      layerTwo: { value: layers[1]?.map ?? layers[0].map },
      scaleOne: { value: layers[0].scale },
      scrollOne: { value: layers[0].scroll },
      scaleTwo: { value: layers[1]?.scale ?? new THREE.Vector2(1, 1) },
      scrollTwo: { value: layers[1]?.scroll ?? new THREE.Vector2(0, 0) },
      secondLayer: { value: layers.length > 1 ? 1 : 0 },
      cloudHeight: { value: Math.max(64, options.cloudHeight) },
      viewer: { value: new THREE.Vector3() },
      time: { value: 0 },
      intensity: { value: 1.0 },
      saturation: { value: 0.72 },
    },

    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPosition = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,

    fragmentShader: /* glsl */ `
      uniform sampler2D layerOne;
      uniform sampler2D layerTwo;
      uniform vec2 scaleOne;
      uniform vec2 scrollOne;
      uniform vec2 scaleTwo;
      uniform vec2 scrollTwo;
      uniform float secondLayer;
      uniform float cloudHeight;
      uniform vec3 viewer;
      uniform float time;
      uniform float intensity;
      uniform float saturation;
      varying vec3 vWorldPosition;

      // Les textures sRGB sont deja decodees en lineaire par le GPU.
      vec3 toLinear(vec3 color) {
        return color;
      }

      void main() {
        vec3 direction = normalize(vWorldPosition - viewer);
        /*
         * Projection des nuages, telle que le jeu la calcule.
         *
         * Le ciel n'est pas une sphere : c'est une calotte tres aplatie, une
         * sphere de quatre mille unites de rayon dont le centre est enfonce
         * sous la carte, et la couche de nuages se trouve a la hauteur que le
         * script declare. Le rayon du regard est croise avec cette calotte, et
         * les coordonnees viennent des arcs cosinus du point trouve.
         *
         * La difference avec une projection spherique se voit entierement a
         * l'horizon : sur une sphere, la latitude n'avance presque plus quand
         * on s'en approche, et les nuages s'etirent en longues bandes floues
         * qu'on prend pour un mur manquant. Sur la calotte, le point
         * d'intersection continue de filer loin devant, et la structure des
         * nuages reste lisible jusqu'en bas.
         */
        const float radiusWorld = 4096.0;
        float height = max(cloudHeight, 1.0);
        // Racine de l'equation du second degre : distance jusqu'a la couche.
        float distance = -radiusWorld * direction.z
          + sqrt(radiusWorld * radiusWorld * direction.z * direction.z
                 + 2.0 * radiusWorld * height + height * height);
        vec3 hit = normalize(direction * distance + vec3(0.0, 0.0, radiusWorld));
        vec2 base = vec2(acos(clamp(hit.x, -1.0, 1.0)), acos(clamp(hit.y, -1.0, 1.0)));

        // Chaque couche est posee a demi-intensite, comme le fait le jeu ;
        // sans cela, une seconde couche additive sature aussitot le ciel.
        vec3 color = toLinear(texture2D(layerOne, base * scaleOne + scrollOne * time).rgb) * 0.5;
        if (secondLayer > 0.5) {
          color += toLinear(texture2D(layerTwo, base * scaleTwo + scrollTwo * time).rgb) * 0.5;
        }

        /*
         * Les nuages d'origine sont tres satures : sur un ciel qui occupe le
         * tiers de l'image, cela repeint toute la scene. On garde la teinte,
         * on en retire une part.
         */
        float grey = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(vec3(grey), color, saturation);
        gl_FragColor = vec4(color * intensity, 1.0);
      }
    `,
    fog: false,
    /*
     * Une face de ciel est une ouverture vers le fond, pas un mur. Si elle
     * ecrit la profondeur, elle decoupe net le decor situe derriere elle :
     * murs tronques, sols troues, passerelles coupees. Dessinee en premier et
     * sans ecrire la profondeur, elle sert de fond et ne masque plus rien.
     */
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  return material;
}
