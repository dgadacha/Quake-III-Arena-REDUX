/**
 * Les octets lus dans les archives arrivent avec un type de tampon large. Les
 * interfaces du navigateur en demandent un plus etroit : ces deux fonctions
 * font le rapprochement sans copier les donnees.
 */

export type StrictBytes = Uint8Array<ArrayBuffer>;

export function asBytes(bytes: Uint8Array): StrictBytes {
  return bytes as StrictBytes;
}

export function asBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart;
}
