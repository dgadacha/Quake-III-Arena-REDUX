import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { ModernRenderSettings } from '../RenderSettings';
import { NEUTRAL_GRADE, type MapGrade } from '../grading/MapGrading';

/**
 * Derniere etape avant l'affichage : l'image en virgule flottante est ramenee
 * dans l'intervalle affichable, puis retouchee. Tout tient en une seule passe,
 * ce qui evite d'empiler des allers-retours de texture pour rien.
 *
 * L'etalonnage reste discret : il s'agit de mettre en valeur l'ambiance de la
 * carte, pas de la remplacer.
 */
const ToneMappingShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    exposure: { value: 1 },
    whitePoint: { value: 4 },
    contrast: { value: 1 },
    saturation: { value: 1 },
    brightness: { value: 0 },
    temperature: { value: 0 },
    tint: { value: 0 },
    shadowLift: { value: 0 },
    splitTone: { value: 0 },
    gradingEnabled: { value: 1 },
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
    uniform float exposure;
    uniform float whitePoint;
    uniform float contrast;
    uniform float saturation;
    uniform float brightness;
    uniform float temperature;
    uniform float tint;
    uniform float shadowLift;
    uniform float splitTone;
    uniform float gradingEnabled;
    varying vec2 vUv;

    // Courbe filmique : les hautes lumieres se tassent au lieu de se couper net.
    vec3 acesFilmic(vec3 color) {
      const float a = 2.51;
      const float b = 0.03;
      const float c = 2.43;
      const float d = 0.59;
      const float e = 0.14;
      return clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);
    }

    float gradeLuminance(vec3 color) {
      return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb * exposure;

      // Le point blanc dit a partir de quelle intensite l'image sature.
      float white = max(whitePoint, 0.001);
      color = acesFilmic(color / white * 4.0);

      if (gradingEnabled > 0.5) {
        // Temperature et teinte : un simple decalage des canaux suffit ici.
        color.r *= 1.0 + temperature * 0.12;
        color.b *= 1.0 - temperature * 0.12;
        color.g *= 1.0 + tint * 0.12;

        color = mix(vec3(gradeLuminance(color)), color, saturation);
        /*
         * Le contraste pivote autour du gris moyen, pas autour de la moitie de
         * l'echelle. Une salle sombre a sa moyenne loin sous 0,5 : pivoter a
         * 0,5 y ecrasait tout vers le noir des que le contraste depassait un,
         * et c'est l'inverse de ce qu'on cherche.
         */
        const float pivot = 0.18;
        color = (color - pivot) * contrast + pivot;
        color += brightness;

        /*
         * Etalonnage par zones. Les ombres partent vers le froid, les hautes
         * lumieres vers le chaud : les deux bouts de l'echelle s'ecartent, ce
         * qui donne de la profondeur sans toucher aux couleurs du jeu. Les
         * verts et les rouges de Quake, qui vivent dans les tons moyens, ne
         * sont pas concernes.
         */
        float level = gradeLuminance(color);
        /*
         * Les deux teintes ajoutent, jamais ne retirent : soustraire du rouge
         * dans une ombre la ramene au noir, et c'est precisement ce qu'on
         * cherche a eviter. L'ecart se lit quand meme, puisque l'un des deux
         * bouts recoit du bleu et l'autre du rouge.
         */
        vec3 cool = vec3(0.0, 0.002, 0.016);
        vec3 warm = vec3(0.016, 0.004, 0.0);
        color += cool * splitTone * (1.0 - smoothstep(0.0, 0.42, level));
        color += warm * splitTone * smoothstep(0.38, 1.0, level);
      }

      /*
       * Relevement du point noir, dans les ombres seulement.
       *
       * Une soustraction seche detruit la matiere : les pixels les plus
       * sombres sortent de la courbe filmique autour d'un centieme, et le
       * moindre decalage negatif les ramene a zero. On remonte donc le
       * plancher. Mais le relever sur toute l'echelle poserait un voile gris
       * sur l'image entiere : le relevement s'eteint donc avec la luminance, et
       * ne touche que le bas de la plage.
       */
      float darkness = 1.0 - smoothstep(0.0, 0.14, gradeLuminance(color));
      color += shadowLift * darkness;

      gl_FragColor = sRGBTransferOETF(vec4(max(color, vec3(0.0)), texel.a));
    }
  `,
};

/**
 * Tone mapping et etalonnage.
 *
 * Deux sources se combinent : les reglages du joueur, et l'intention de la
 * carte affichee. Les multiplicateurs se multiplient, les decalages
 * s'ajoutent : le joueur garde la main sur l'image, la carte garde son
 * caractere.
 */
export class ToneMappingPass extends ShaderPass {
  private settings: ModernRenderSettings;
  private grade: MapGrade = NEUTRAL_GRADE;

  constructor(settings: ModernRenderSettings) {
    super(ToneMappingShader);
    this.settings = settings;
    this.apply(settings);
  }

  apply(settings: ModernRenderSettings): void {
    this.settings = settings;
    this.refresh();
  }

  /** Intention de la carte affichee. */
  setGrade(grade: MapGrade): void {
    this.grade = grade;
    this.refresh();
  }

  private refresh(): void {
    const settings = this.settings;
    const grade = settings.colorGrading ? this.grade : NEUTRAL_GRADE;
    const uniforms = this.uniforms as Record<string, { value: number }>;
    uniforms.exposure.value = settings.exposure * grade.exposure;
    uniforms.whitePoint.value = settings.whitePoint * grade.whitePoint;
    uniforms.contrast.value = settings.contrast * grade.contrast;
    uniforms.saturation.value = settings.saturation * grade.saturation;
    // Une intention de carte ne peut pas assombrir par soustraction : c'est
    // ce qui bouchait les noirs. Elle eclaircit, ou ne fait rien.
    uniforms.brightness.value = settings.brightness + Math.max(0, grade.brightness);
    uniforms.temperature.value = settings.temperature + grade.temperature;
    uniforms.tint.value = settings.tint + grade.tint;
    uniforms.shadowLift.value = Math.max(0, settings.shadowLift + grade.shadowLift);
    uniforms.splitTone.value = Math.max(0, settings.splitTone);
    uniforms.gradingEnabled.value = settings.colorGrading ? 1 : 0;
  }
}
