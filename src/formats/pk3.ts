/**
 * Archives .pk3 : ce sont des fichiers zip. Le catalogue est lu a l'ouverture,
 * puis chaque entree est extraite a la demande. Les donnees ne sont jamais
 * chargees en entier : une archive de plusieurs centaines de megaoctets
 * s'ouvre en lisant quelques kilooctets a la fin du fichier.
 */

import { asBlobPart } from '../util/bytes';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export interface ZipEntry {
  name: string;
  /** 0 = stocke tel quel, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  /** Position de l'en-tete local : les donnees suivent. */
  headerOffset: number;
}

/** Acces a un bloc d'octets, quelle qu'en soit la provenance. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class MemorySource implements ByteSource {
  constructor(private readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes.subarray(offset, offset + length);
  }
}

/** Fichier depose par l'utilisateur : lu par tranches, sans copie complete. */
export class BlobSource implements ByteSource {
  constructor(private readonly blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.blob.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }
}

/** Fichier servi par le serveur de developpement, lu par plages. */
/** Longueur du suffixe lu a l'ouverture : de quoi contenir le catalogue de fin. */
const TAIL_LENGTH = 0xffff + 22;

/** Plage effectivement servie, telle que l'en-tete la decrit. */
function parseContentRange(header: string | null): { start: number; size: number } | null {
  if (!header) return null;
  const match = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const size = Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(size) || size <= 0) return null;
  return { start, size };
}

export class HttpRangeSource implements ByteSource {
  /** Nombre d'acces effectues, toutes archives confondues. */
  static reads = 0;

  /** Derniers octets du fichier, deja lus a l'ouverture. */
  private tail: Uint8Array | null = null;
  private tailStart = 0;

  private constructor(readonly url: string, readonly size: number) {}

  /**
   * Ouvre une archive en un seul acces. Demander un suffixe du fichier rend a
   * la fois sa taille, annoncee dans l'en-tete de plage, et ses derniers
   * octets, ou se trouve le catalogue : une sonde de taille separee serait un
   * acces de plus par archive, et il y en a une quinzaine a monter.
   */
  static async open(url: string, tailLength = TAIL_LENGTH): Promise<HttpRangeSource> {
    HttpRangeSource.reads++;
    const response = await fetch(url, { headers: { Range: `bytes=-${tailLength}` } });
    if (!response.ok) throw new Error(`${url}: reponse ${response.status}`);

    const range = parseContentRange(response.headers.get('content-range'));
    let tail = new Uint8Array(await response.arrayBuffer());

    if (!range) {
      // Sans en-tete de plage, la reponse porte le fichier entier.
      const source = new HttpRangeSource(url, tail.byteLength);
      source.tail = tail;
      source.tailStart = 0;
      return source;
    }

    const source = new HttpRangeSource(url, range.size);
    let start = range.start;

    /*
     * Tous les serveurs ne comprennent pas la demande de suffixe : certains,
     * dont celui de developpement, repondent par le debut du fichier. Le
     * catalogue etant a la fin, il faut s'en apercevoir et redemander la bonne
     * plage, sans quoi l'archive parait sans catalogue.
     */
    const expected = Math.max(0, range.size - tailLength);
    if (start !== expected) {
      const wanted = Math.min(tailLength, range.size);
      // Copie : la lecture rend une vue, et cette fin de fichier est gardee.
      tail = new Uint8Array(await source.read(range.size - wanted, wanted));
      start = range.size - wanted;
    }

    source.tail = tail;
    source.tailStart = start;
    return source;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    // La fin du fichier est deja en main depuis l'ouverture : la redemander
    // couterait un acces pour rien, et c'est la qu'est tout le catalogue.
    if (this.tail && offset >= this.tailStart && offset + length <= this.tailStart + this.tail.byteLength) {
      const from = offset - this.tailStart;
      return this.tail.subarray(from, from + length);
    }

    HttpRangeSource.reads++;
    const end = Math.min(offset + length, this.size) - 1;
    const response = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end}` } });
    if (!response.ok) throw new Error(`${this.url}: reponse ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Decompresse un bloc deflate brut avec le decompresseur du navigateur. */
async function inflateRaw(data: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('Ce navigateur ne sait pas decompresser les archives (DecompressionStream absent)');
  }
  const stream = new Blob([asBlobPart(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(expectedSize > 0 ? expectedSize : total);
  let cursor = 0;
  for (const chunk of chunks) {
    if (cursor >= out.byteLength) break;
    out.set(chunk.subarray(0, Math.min(chunk.byteLength, out.byteLength - cursor)), cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

export class Pk3Archive {
  readonly entries = new Map<string, ZipEntry>();
  private readonly cache = new Map<string, Uint8Array>();

  private constructor(private readonly source: ByteSource, readonly label: string) {}

  static async open(source: ByteSource, label = 'pk3'): Promise<Pk3Archive> {
    const archive = new Pk3Archive(source, label);
    await archive.readCentralDirectory();
    return archive;
  }

  private async readCentralDirectory(): Promise<void> {
    // Le bloc de fin tient dans les derniers octets, commentaire compris.
    const tailLength = Math.min(this.source.size, 0xffff + 22);
    const tail = await this.source.read(this.source.size - tailLength, tailLength);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

    let eocd = -1;
    for (let at = tail.byteLength - 22; at >= 0; at--) {
      if (tailView.getUint32(at, true) === SIG_EOCD) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${this.label}: catalogue zip introuvable`);

    let count = tailView.getUint16(eocd + 10, true);
    let directoryOffset = tailView.getUint32(eocd + 16, true);
    let directorySize = tailView.getUint32(eocd + 12, true);

    // Au-dela de 65535 entrees ou de 4 Go, ces champs sont ranges ailleurs.
    if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
      const locator = eocd - 20;
      if (locator >= 0 && tailView.getUint32(locator, true) === SIG_EOCD64_LOCATOR) {
        const at = Number(tailView.getBigUint64(locator + 8, true));
        const header = await this.source.read(at, 56);
        const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (headerView.getUint32(0, true) === SIG_EOCD64) {
          count = Number(headerView.getBigUint64(32, true));
          directorySize = Number(headerView.getBigUint64(40, true));
          directoryOffset = Number(headerView.getBigUint64(48, true));
        }
      }
    }

    const directory = await this.source.read(directoryOffset, directorySize);
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const decoder = new TextDecoder('utf-8');

    let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.byteLength) break;
      if (view.getUint32(cursor, true) !== SIG_CENTRAL) break;

      const method = view.getUint16(cursor + 10, true);
      let compressedSize = view.getUint32(cursor + 20, true);
      let size = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      let headerOffset = view.getUint32(cursor + 42, true);
      const name = decoder
        .decode(directory.subarray(cursor + 46, cursor + 46 + nameLength))
        .replace(/\\/g, '/')
        .toLowerCase();

      if (size === 0xffffffff || compressedSize === 0xffffffff || headerOffset === 0xffffffff) {
        const zip64 = readZip64Extra(view, cursor + 46 + nameLength, extraLength);
        if (zip64) {
          size = zip64[0] ?? size;
          compressedSize = zip64[1] ?? compressedSize;
          headerOffset = zip64[2] ?? headerOffset;
        }
      }

      cursor += 46 + nameLength + extraLength + commentLength;
      // Les dossiers sont des entrees vides terminees par une barre oblique.
      if (name.endsWith('/')) continue;
      this.entries.set(name, { name, method, compressedSize, size, headerOffset });
    }
  }

  has(path: string): boolean {
    return this.entries.has(path.toLowerCase());
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Lit plusieurs entrees en un minimum d'acces. Les entrees sont triees par
   * position, puis regroupees quand elles se suivent de pres : on obtient
   * quelques lectures continues au lieu d'une lecture par fichier.
   *
   * L'ecart compte beaucoup a froid : dans une archive de plusieurs centaines
   * de megaoctets, soixante-seize acces disperses coutent des secondes, la
   * meme quantite de donnees lue d'affilee coute quelques dizaines de
   * millisecondes.
   */
  async readMany(paths: string[]): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>();
    const pending: ZipEntry[] = [];

    for (const path of paths) {
      const key = path.toLowerCase();
      const cached = this.cache.get(key);
      if (cached) {
        found.set(key, cached);
        continue;
      }
      const entry = this.entries.get(key);
      if (entry) pending.push(entry);
    }
    if (pending.length === 0) return found;

    pending.sort((a, b) => a.headerOffset - b.headerOffset);

    // Un trou de moins d'un quart de megaoctet ne justifie pas un acces de plus.
    const MAX_GAP = 256 * 1024;
    const MAX_SPAN = 16 * 1024 * 1024;
    let group: ZipEntry[] = [];
    let start = 0;
    let end = 0;

    const flush = async () => {
      if (group.length === 0) return;
      const block = await this.source.read(start, end - start);
      for (const entry of group) {
        const data = await this.extract(entry, block, start);
        if (data) {
          found.set(entry.name, data);
          if (data.byteLength <= 1024 * 1024) this.cache.set(entry.name, data);
        }
      }
      group = [];
    };

    for (const entry of pending) {
      // L'en-tete local precede les donnees : il faut le lire aussi.
      const entryStart = entry.headerOffset;
      const entryEnd = entry.headerOffset + 30 + 512 + entry.compressedSize;
      if (group.length === 0) {
        group = [entry];
        start = entryStart;
        end = entryEnd;
        continue;
      }
      if (entryStart - end <= MAX_GAP && entryEnd - start <= MAX_SPAN) {
        group.push(entry);
        end = Math.max(end, entryEnd);
        continue;
      }
      await flush();
      group = [entry];
      start = entryStart;
      end = entryEnd;
    }
    await flush();

    return found;
  }

  /** Extrait une entree deja presente dans un bloc lu d'avance. */
  private async extract(entry: ZipEntry, block: Uint8Array, blockStart: number): Promise<Uint8Array | null> {
    const at = entry.headerOffset - blockStart;
    if (at < 0 || at + 30 > block.byteLength) return null;
    const view = new DataView(block.buffer, block.byteOffset + at, Math.min(30, block.byteLength - at));
    if (view.getUint32(0, true) !== SIG_LOCAL) return null;

    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const from = at + 30 + nameLength + extraLength;
    const raw = block.subarray(from, from + entry.compressedSize);
    if (raw.byteLength < entry.compressedSize) return null;

    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw, entry.size);
    return null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const key = path.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const entry = this.entries.get(key);
    if (!entry) return null;

    // L'en-tete local redit la longueur du nom : les donnees commencent apres.
    const header = await this.source.read(entry.headerOffset, 30);
    if (header.byteLength < 30) return null;
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (headerView.getUint32(0, true) !== SIG_LOCAL) {
      console.warn(`${this.label}: en-tete local invalide pour ${entry.name}`);
      return null;
    }
    const nameLength = headerView.getUint16(26, true);
    const extraLength = headerView.getUint16(28, true);
    const start = entry.headerOffset + 30 + nameLength + extraLength;
    const raw = await this.source.read(start, entry.compressedSize);

    let data: Uint8Array;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = await inflateRaw(raw, entry.size);
    else throw new Error(`${this.label}: methode de compression ${entry.method} non prise en charge`);

    // Seuls les petits fichiers restent en memoire : textures et scripts.
    if (data.byteLength <= 1024 * 1024) this.cache.set(key, data);
    return data;
  }
}

function readZip64Extra(view: DataView, offset: number, length: number): number[] | null {
  let cursor = offset;
  const end = offset + length;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (id === 0x0001) {
      const values: number[] = [];
      for (let at = cursor + 4; at + 8 <= cursor + 4 + size; at += 8) {
        values.push(Number(view.getBigUint64(at, true)));
      }
      return values;
    }
    cursor += 4 + size;
  }
  return null;
}

/**
 * Systeme de fichiers virtuel : les archives montees en dernier gagnent, comme
 * l'ordre pak0, pak1, pak2 du jeu d'origine.
 */
export class VirtualFileSystem {
  private readonly archives: Pk3Archive[] = [];
  private readonly loose = new Map<string, Uint8Array>();

  mount(archive: Pk3Archive): void {
    this.archives.push(archive);
  }

  get mounted(): string[] {
    return this.archives.map((archive) => archive.label);
  }

  get fileCount(): number {
    return this.list().length;
  }

  /** Fichier fourni seul, hors archive : une carte .bsp deposee a la main. */
  addFile(path: string, data: Uint8Array): void {
    this.loose.set(normalize(path), data);
  }

  has(path: string): boolean {
    const key = normalize(path);
    if (this.loose.has(key)) return true;
    return this.archives.some((archive) => archive.has(key));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const key = normalize(path);
    const direct = this.loose.get(key);
    if (direct) return direct;
    for (let i = this.archives.length - 1; i >= 0; i--) {
      if (!this.archives[i].has(key)) continue;
      try {
        const found = await this.archives[i].read(key);
        if (found) return found;
      } catch (error) {
        // Une archive abimee ne doit pas empecher les autres de repondre.
        console.warn(`${this.archives[i].label}: ${key} illisible`, error);
      }
    }
    return null;
  }

  async readText(path: string): Promise<string | null> {
    const data = await this.read(path);
    return data ? new TextDecoder('latin1').decode(data) : null;
  }

  /**
   * Lit un ensemble de fichiers en groupant les acces par archive. L'ordre de
   * priorite est respecte : chaque chemin est cherche dans la derniere archive
   * qui le contient.
   */
  async readTextMany(paths: string[]): Promise<Map<string, string>> {
    const byArchive = new Map<number, string[]>();
    const result = new Map<string, string>();

    for (const path of paths) {
      const key = normalize(path);
      const direct = this.loose.get(key);
      if (direct) {
        result.set(key, new TextDecoder('latin1').decode(direct));
        continue;
      }
      for (let i = this.archives.length - 1; i >= 0; i--) {
        if (!this.archives[i].has(key)) continue;
        const list = byArchive.get(i) ?? [];
        list.push(key);
        byArchive.set(i, list);
        break;
      }
    }

    const decoder = new TextDecoder('latin1');
    for (const [index, list] of byArchive) {
      try {
        const files = await this.archives[index].readMany(list);
        for (const [key, data] of files) result.set(key, decoder.decode(data));
      } catch (error) {
        console.warn(`${this.archives[index].label}: lecture groupee impossible`, error);
      }
    }
    return result;
  }

  /**
   * Cherche un fichier dont l'extension n'est pas connue : les scripts nomment
   * les textures sans extension, a charge du moteur de trouver le bon fichier.
   */
  async readAny(base: string, extensions: string[]): Promise<{ path: string; data: Uint8Array } | null> {
    const key = normalize(base).replace(/\.(tga|jpg|jpeg|png)$/i, '');
    for (const extension of extensions) {
      const path = `${key}.${extension}`;
      const data = await this.read(path);
      if (data) return { path, data };
    }
    return null;
  }

  /** Tous les chemins connus, archives et fichiers isoles confondus. */
  list(filter?: (path: string) => boolean): string[] {
    const paths = new Set<string>(this.loose.keys());
    for (const archive of this.archives) for (const path of archive.list()) paths.add(path);
    const all = [...paths];
    return (filter ? all.filter(filter) : all).sort();
  }

  listByExtension(extension: string, prefix = ''): string[] {
    const suffix = extension.startsWith('.') ? extension : `.${extension}`;
    return this.list((path) => path.endsWith(suffix) && path.startsWith(prefix));
  }
}

function normalize(path: string): string {
  return path.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
}
