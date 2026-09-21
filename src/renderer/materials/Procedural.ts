import * as THREE from 'three';

/**
 * Textures fabriquees au chargement. Elles servent a l'arene de demonstration,
 * qui doit tourner sans aucun fichier exterieur, et de remplacement quand une
 * carte reclame une texture absente.
 */

export interface SurfaceTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const cache = new Map<string, SurfaceTextures>();

function canvas(size: number): { context: CanvasRenderingContext2D; image: HTMLCanvasElement } {
  const image = document.createElement('canvas');
  image.width = size;
  image.height = size;
  const context = image.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('canvas 2d indisponible');
  return { context, image };
}

/** Bruit de valeur lisse, empile sur plusieurs octaves. */
function noiseField(size: number, octaves: number, seed: number): Float32Array {
  const field = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const cells = 2 << octave;
    const grid = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = random(seed + octave * 977 + i * 131);
    const step = size / cells;
    for (let y = 0; y < size; y++) {
      const gy = y / step;
      const y0 = Math.floor(gy);
      const fy = smooth(gy - y0);
      for (let x = 0; x < size; x++) {
        const gx = x / step;
        const x0 = Math.floor(gx);
        const fx = smooth(gx - x0);
        const a = grid[y0 * (cells + 1) + x0];
        const b = grid[y0 * (cells + 1) + x0 + 1];
        const c = grid[(y0 + 1) * (cells + 1) + x0];
        const d = grid[(y0 + 1) * (cells + 1) + x0 + 1];
        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        field[y * size + x] += (top + (bottom - top) * fy) * amplitude;
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < field.length; i++) field[i] /= total;
  return field;
}

function random(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Normales deduites de la pente d'une carte de hauteur. */
function normalFromHeight(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const left = height[y * size + ((x - 1 + size) % size)];
      const right = height[y * size + ((x + 1) % size)];
      const up = height[((y - 1 + size) % size) * size + x];
      const down = height[((y + 1) % size) * size + x];
      const dx = (left - right) * strength;
      const dy = (up - down) * strength;
      const inverse = 1 / Math.hypot(dx, dy, 1);
      const index = (y * size + x) * 4;
      data[index] = Math.round((dx * inverse * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round((dy * inverse * 0.5 + 0.5) * 255);
      data[index + 2] = Math.round((inverse * 0.5 + 0.5) * 255);
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function grayTexture(values: Float32Array, size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < values.length; i++) {
    const level = Math.max(0, Math.min(255, Math.round(values[i] * 255)));
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function finish(texture: THREE.Texture, srgb: boolean): THREE.Texture {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export type SurfaceKind = 'metal' | 'floor' | 'trim' | 'rock' | 'grate' | 'glow' | 'water';

/** Fabrique la couleur, le relief et la rugosite d'une surface. */
export function surfaceTextures(kind: SurfaceKind, tint = '#6b7078'): SurfaceTextures {
  const key = `${kind}:${tint}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 256;
  const { context, image } = canvas(size);
  const grain = noiseField(size, 5, kind.length * 37 + tint.length);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);

  context.fillStyle = tint;
  context.fillRect(0, 0, size, size);

  const pixels = context.getImageData(0, 0, size, size);
  const base = new THREE.Color(tint);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const noise = grain[index];
      let shade = 0.85 + noise * 0.3;
      let bump = noise * 0.3;
      let roughness = 0.55 + noise * 0.2;

      switch (kind) {
        case 'metal': {
          // Panneaux rives, separes par des rainures.
          const cell = 64;
          const inX = x % cell;
          const inY = y % cell;
          const edge = inX < 3 || inY < 3 || inX > cell - 4 || inY > cell - 4;
          if (edge) {
            shade *= 0.55;
            bump -= 0.5;
            roughness += 0.2;
          }
          const rivet = Math.hypot(inX - 10, inY - 10) < 3 || Math.hypot(inX - cell + 10, inY - cell + 10) < 3;
          if (rivet) {
            shade *= 1.25;
            bump += 0.7;
            roughness -= 0.25;
          }
          break;
        }
        case 'floor': {
          // Dalles larges, joints creuses, usure au centre.
          const cell = 128;
          const inX = x % cell;
          const inY = y % cell;
          if (inX < 4 || inY < 4) {
            shade *= 0.6;
            bump -= 0.6;
          }
          const wear = 1 - Math.hypot(inX - cell / 2, inY - cell / 2) / cell;
          shade *= 0.9 + wear * 0.25;
          roughness += wear * 0.15;
          break;
        }
        case 'trim': {
          // Bandes horizontales alternees, metal poli.
          const band = Math.floor(y / 16) % 2 === 0;
          shade *= band ? 1.15 : 0.7;
          bump += band ? 0.35 : -0.35;
          roughness = band ? 0.25 : 0.45;
          break;
        }
        case 'rock': {
          const crack = Math.abs(Math.sin(x * 0.08 + noise * 6) * Math.cos(y * 0.05 + noise * 4));
          shade *= 0.75 + crack * 0.5;
          bump += crack * 0.8 - 0.2;
          roughness = 0.85 - crack * 0.15;
          break;
        }
        case 'grate': {
          // Caillebotis : barres croisees et vides sombres.
          const bar = x % 24 < 8 || y % 24 < 8;
          shade *= bar ? 1.1 : 0.35;
          bump += bar ? 0.6 : -0.8;
          roughness = bar ? 0.4 : 0.9;
          break;
        }
        case 'glow': {
          const pulse = 0.6 + 0.4 * Math.sin((y / size) * Math.PI * 4);
          shade *= 1.1 + pulse * 0.4;
          roughness = 0.3;
          break;
        }
        case 'water': {
          const ripple = Math.sin(x * 0.12 + noise * 5) * Math.cos(y * 0.1 + noise * 5);
          shade *= 0.9 + ripple * 0.15;
          bump += ripple * 0.4;
          roughness = 0.08;
          break;
        }
      }

      const offset = index * 4;
      pixels.data[offset] = clampByte(base.r * 255 * shade);
      pixels.data[offset + 1] = clampByte(base.g * 255 * shade);
      pixels.data[offset + 2] = clampByte(base.b * 255 * shade);
      pixels.data[offset + 3] = 255;
      height[index] = bump;
      rough[index] = Math.max(0.05, Math.min(1, roughness));
    }
  }

  context.putImageData(pixels, 0, 0);
  const map = finish(new THREE.CanvasTexture(image), true);
  const textures: SurfaceTextures = {
    map,
    normalMap: finish(normalFromHeight(height, size, kind === 'grate' ? 6 : 3), false),
    roughnessMap: finish(grayTexture(rough, size), false),
  };
  cache.set(key, textures);
  return textures;
}

/** Ciel : degrade vertical et nuages, en cube pour l'arriere-plan. */
export function skyTexture(top: string, bottom: string): THREE.Texture {
  const size = 512;
  const { context, image } = canvas(size);
  const gradient = context.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const clouds = noiseField(size, 6, 17);
  const pixels = context.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const band = Math.max(0, 1 - y / (size * 0.75));
      const value = Math.max(0, clouds[index] - 0.55) * 2.2 * band;
      const offset = index * 4;
      pixels.data[offset] = clampByte(pixels.data[offset] + value * 90);
      pixels.data[offset + 1] = clampByte(pixels.data[offset + 1] + value * 80);
      pixels.data[offset + 2] = clampByte(pixels.data[offset + 2] + value * 70);
    }
  }
  context.putImageData(pixels, 0, 0);
  return finish(new THREE.CanvasTexture(image), true);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
