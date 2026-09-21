import * as THREE from 'three';

/** Subdivision reservee aux nappes de lave, avec conservation des plages PVS. */
export function subdivideLava(geometry: THREE.BufferGeometry,
  ranges: { face: number; start: number; count: number }[]): void {
  const index = geometry.index;
  if (!index) return;
  const attributes = Object.entries(geometry.attributes);
  const arrays = attributes.map(([, attribute]) => Array.from(attribute.array));
  const indices: number[] = [];
  const mids = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const cached = mids.get(key);
    if (cached !== undefined) return cached;
    const result = arrays[0].length / attributes[0][1].itemSize;
    attributes.forEach(([, attribute], i) => {
      for (let j = 0; j < attribute.itemSize; j++) {
        arrays[i].push((arrays[i][a * attribute.itemSize + j] + arrays[i][b * attribute.itemSize + j]) / 2);
      }
    });
    mids.set(key, result);
    return result;
  };
  const split = (a: number, b: number, c: number, depth: number): void => {
    if (depth === 0) { indices.push(a, b, c); return; }
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    split(a, ab, ca, depth - 1); split(ab, b, bc, depth - 1);
    split(ca, bc, c, depth - 1); split(ab, bc, ca, depth - 1);
  };
  for (const range of ranges) {
    const start = indices.length;
    for (let i = range.start; i < range.start + range.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      split(a, b, c, Math.abs(geometry.attributes.normal.getZ(a)) > 0.6 ? 3 : 0);
    }
    range.start = start;
    range.count = indices.length - start;
  }
  attributes.forEach(([name, attribute], i) => {
    geometry.setAttribute(name, new THREE.Float32BufferAttribute(arrays[i], attribute.itemSize));
  });
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 2;
}
