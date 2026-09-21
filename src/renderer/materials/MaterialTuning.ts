/** Direction des matieres de q3dm7, appliquee uniquement aux versions HD.
 * Les dalles vertes peintes restent identifiables, avec une patine plus neutre
 * et des reflets sur l'usure. Les murs rouilles gardent une reponse plus mate.
 */
export interface MaterialTuning {
  saturation: number;
  tint: [number, number, number];
  roughness: number;
  environment: number;
  metalnessLimit: number;
  normal: number;
  specular: number;
}

const FLOOR: MaterialTuning = {
  saturation: 0.48,
  tint: [1.04, 0.93, 0.88],
  roughness: 0.78,
  environment: 0.95,
  metalnessLimit: 0.3,
  normal: 1.15,
  specular: 2.5,
};

const TUNING: Record<string, MaterialTuning> = {
  'textures/gothic_floor/q1metal7_99': FLOOR,
  'textures/gothic_floor/q1metal7_99stair': FLOOR,
  'textures/gothic_floor/q1metal7_99stair2': FLOOR,
  'textures/gothic_floor/q1metal7_99stair3': FLOOR,
  'textures/gothic_trim/pitted_rust3': {
    saturation: 0.82,
    tint: [1, 0.98, 0.96],
    roughness: 0.92,
    environment: 0.65,
    metalnessLimit: 0.5,
    normal: 0.55,
    specular: 1,
  },
};

export function materialTuning(name: string): MaterialTuning | undefined {
  return TUNING[name];
}
