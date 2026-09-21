import * as THREE from 'three';

let cached: THREE.DataTexture | undefined;

/** Tuile periodique partagee : hauteur de croute et pente, calculees une fois. */
export function lavaPattern(): THREE.DataTexture {
  if (cached) return cached;
  const size = 256, cells = 8;
  const height = new Float32Array(size * size);
  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
    const px = x / size * cells + 0.24 * Math.sin(v * 3) + 0.12 * Math.cos(u * 5 + v * 2);
    const py = y / size * cells + 0.24 * Math.cos(u * 3) + 0.12 * Math.sin(v * 5 - u * 2);
    let first = 100, second = 100;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = Math.floor(px) + dx, cy = Math.floor(py) + dy;
      const hx = ((cx % cells) + cells) % cells, hy = ((cy % cells) + cells) % cells;
      const distance = Math.hypot(cx + 0.2 + hash(hx, hy) * 0.6 - px,
        cy + 0.2 + hash(hy + 19, hx + 7) * 0.6 - py);
      if (distance < first) { second = first; first = distance; }
      else if (distance < second) second = distance;
    }
    height[y * size + x] = Math.min(1, (second - first) * 3.4);
  }
  const at = (x: number, y: number) => height[((y + size) % size) * size + (x + size) % size];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    data[i] = at(x, y) * 255;
    data[i + 1] = THREE.MathUtils.clamp(0.5 + (at(x + 1, y) - at(x - 1, y)) * 0.7, 0, 1) * 255;
    data[i + 2] = THREE.MathUtils.clamp(0.5 + (at(x, y + 1) - at(x, y - 1)) * 0.7, 0, 1) * 255;
    data[i + 3] = 255;
  }
  cached = new THREE.DataTexture(data, size, size);
  cached.wrapS = cached.wrapT = THREE.RepeatWrapping;
  cached.minFilter = THREE.LinearMipmapLinearFilter;
  cached.magFilter = THREE.LinearFilter;
  cached.generateMipmaps = true;
  cached.needsUpdate = true;
  return cached;
}
