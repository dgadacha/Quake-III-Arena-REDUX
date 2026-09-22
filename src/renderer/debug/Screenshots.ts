import type * as THREE from 'three';

/**
 * Captures d'ecran, pour la documentation.
 *
 * Deux moitiés, et une difficulte par moitie.
 *
 * Le rendu vit dans un canevas WebGL dont le tampon de dessin n'est pas
 * conserve d'une image a l'autre : le relire plus tard donne du blanc. Il faut
 * donc dessiner et relire dans la meme foulee, puis remettre les lignes dans
 * l'ordre, le tampon commencant par le bas de l'image.
 *
 * L'interface, elle, n'est pas dans le canevas du tout : menu, releve du banc
 * et compteurs sont du HTML pose par-dessus. Pour l'avoir sur la meme image,
 * elle est redessinee dans un SVG a travers foreignObject : les feuilles de
 * style du document y sont recopiees et les images passees en donnees, car une
 * image SVG ne peut rien aller chercher au dehors.
 *
 * Tout cela ne sert qu'a la documentation et ne tourne que depuis la console,
 * sous le serveur de developpement : c'est lui qui recoit l'image et l'ecrit.
 */

const XHTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

/** Dessine une image et relit les pixels affiches, dans le bon sens. */
export function readViewport(
  renderer: THREE.WebGLRenderer,
  draw: () => void,
): HTMLCanvasElement | null {
  const gl = renderer.getContext();
  draw();

  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const image = context.createImageData(width, height);
  for (let row = 0; row < height; row++) {
    const source = (height - 1 - row) * width * 4;
    image.data.set(pixels.subarray(source, source + width * 4), row * width * 4);
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Recopie l'interface par-dessus une image du rendu.
 *
 * Les selecteurs du menu partent de la racine du document, qui n'existe pas
 * dans le SVG : `:root` y devient une classe portee par le div d'accueil, et
 * les attributs de reglage de la racine sont recopies sur lui pour que les
 * regles qui en dependent continuent de s'appliquer.
 */
export async function drawInterface(target: HTMLCanvasElement, root: HTMLElement): Promise<void> {
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;

  const holder = document.createElementNS(XHTML, 'div');
  holder.setAttribute('class', 'shot-root');
  for (const name of document.documentElement.getAttributeNames()) {
    if (name.startsWith('data-')) {
      holder.setAttribute(name, document.documentElement.getAttribute(name) ?? '');
    }
  }
  holder.setAttribute(
    'style',
    `position:relative;width:${width}px;height:${height}px;overflow:hidden;background:transparent;`,
  );

  const style = document.createElementNS(XHTML, 'style');
  style.textContent = readStyleSheets();
  holder.appendChild(style);

  const clone = root.cloneNode(true) as HTMLElement;
  clone.setAttribute('style', 'position:absolute;inset:0;');
  await inlineImages(clone);
  holder.appendChild(clone);

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const foreign = document.createElementNS(SVG, 'foreignObject');
  foreign.setAttribute('width', '100%');
  foreign.setAttribute('height', '100%');
  foreign.appendChild(holder);
  svg.appendChild(foreign);

  const markup = new XMLSerializer().serializeToString(svg);
  const picture = new Image();
  await new Promise<void>((resolve, reject) => {
    picture.onload = () => resolve();
    picture.onerror = () => reject(new Error("l'interface n'a pas pu etre dessinee"));
    picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });

  target.getContext('2d')?.drawImage(picture, 0, 0, target.width, target.height);
}

/** Rapporte l'image a la largeur demandee et l'envoie au serveur. */
export async function writeShot(
  name: string,
  source: HTMLCanvasElement,
  width: number,
): Promise<string> {
  const scale = Math.min(1, width / source.width);
  const target = document.createElement('canvas');
  target.width = Math.round(source.width * scale);
  target.height = Math.round(source.height * scale);
  const context = target.getContext('2d');
  if (!context) return 'canevas 2d indisponible';
  // Reduction en deux temps quand le rapport est grand : un seul saut lisse trop.
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, target.width, target.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    target.toBlob(resolve, 'image/jpeg', 0.92),
  );
  if (!blob) return 'image illisible';
  const response = await fetch(`/__shot?name=${encodeURIComponent(name)}&type=jpeg`, {
    method: 'POST',
    body: blob,
  });
  const answer = await response.text();
  return `${response.status} ${answer} (${Math.round(blob.size / 1024)} ko, ${target.width}x${target.height})`;
}

/** Texte de toutes les feuilles lisibles, `:root` ramene au div d'accueil. */
function readStyleSheets(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    // Une feuille d'un autre domaine ne se lit pas : on passe.
    try {
      rules = sheet.cssRules;
    } catch {
      rules = null;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) parts.push(rule.cssText);
  }
  return parts.join('\n').replace(/:root/g, '.shot-root');
}

/** Passe les images du fragment en donnees : le SVG ne sort pas de lui-meme. */
async function inlineImages(node: HTMLElement): Promise<void> {
  const images = Array.from(node.querySelectorAll('img'));
  await Promise.all(
    images.map(async (image) => {
      const source = image.getAttribute('src');
      if (!source || source.startsWith('data:')) return;
      try {
        const blob = await fetch(source).then((response) => response.blob());
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('lecture impossible'));
          reader.readAsDataURL(blob);
        });
        image.setAttribute('src', data);
      } catch {
        image.remove();
      }
    }),
  );
}
