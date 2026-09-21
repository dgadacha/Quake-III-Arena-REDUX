#!/usr/bin/env node
/**
 * Recense les archives .pk3 presentes dans public/data et ecrit le manifeste
 * que le moteur lit au demarrage. Les donnees du jeu restent ou elles sont :
 * public/data peut contenir de simples liens vers votre installation.
 */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(root, 'public', 'data');

/** Tri naturel : pak2 avant pak10, pak8 avant pak8a. */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

async function listArchives(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isFile() && entry.name.toLowerCase().endsWith('.pk3')) archives.push(entry.name);
  }
  return archives.sort(naturalCompare);
}

async function main() {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const mods = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dataDir, entry.name);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) continue;

    const archives = await listArchives(full);
    if (archives.length === 0) continue;
    mods.push({
      name: entry.name,
      archives: archives.map((file) => `data/${entry.name}/${file}`),
    });
  }

  // Archives posees directement dans public/data.
  const loose = await listArchives(dataDir);
  if (loose.length > 0) {
    mods.unshift({ name: 'data', archives: loose.map((file) => `data/${file}`) });
  }

  const manifest = { mods };
  const target = join(dataDir, 'manifest.json');
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);

  const total = mods.reduce((sum, mod) => sum + mod.archives.length, 0);
  console.log(`${relative(root, target)} : ${mods.length} dossier(s), ${total} archive(s)`);
  for (const mod of mods) console.log(`  ${mod.name} : ${mod.archives.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
