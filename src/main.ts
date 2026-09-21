import { BlobSource, HttpRangeSource, Pk3Archive, VirtualFileSystem } from './formats/pk3';
import { ShaderLibrary } from './formats/shader';
import { buildDemoArena } from './game/demo/arena';
import { FOCUS_MAP, isFocusMap } from './game/focus';
import { loadBspLevel } from './game/bspLevel';
import { Session } from './game/session';
import { Overlay, type MapEntry } from './ui/overlay';
import { SettingsPanel } from './ui/SettingsPanel';
import { UIManager } from './ui/core/UIManager';
import { createHud } from './ui/hud/Hud';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const overlayRoot = document.getElementById('overlay') as HTMLElement;

const session = new Session(canvas);
const overlay = new Overlay(overlayRoot);
// Couche d'interface : elle lit l'etat du jeu, elle ne le pilote pas.
const ui = new UIManager(overlayRoot);
createHud(ui);
session.attachUI(ui);
ui.setHudVisible(false);
const settingsPanel = new SettingsPanel(overlayRoot, session.settings);
const params = new URLSearchParams(location.search);
/** Derniere carte jouee : un reglage de chargement demande de la reprendre. */
let currentMap: MapEntry | null = null;

interface DataManifest {
  mods: { name: string; archives: string[] }[];
}

let manifest: DataManifest = { mods: [] };
let vfs = new VirtualFileSystem();
let shaders = new ShaderLibrary();
let activeSource = '';
let busy = false;

session.onStats = (stats) => overlay.updateStats(stats);

// Point d'entree du panneau de mise au point et des essais depuis la console.
(window as unknown as Record<string, unknown>).__q3 = {
  session,
  vfs: () => vfs,
  shaders: () => shaders,
  mountTimings: () => mountTimings,
  demo: () => playDemo(),
  banc: (index = 0) => session.benchmark(index),
  luminance: (samples = 320) => session.histogram(samples),
  weapon: () => session.measureViewModel(),
};

/** Laisse le navigateur peindre entre deux etapes lourdes. */
const yieldToBrowser = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function readManifest(): Promise<DataManifest> {
  try {
    const response = await fetch('data/manifest.json');
    if (!response.ok) return { mods: [] };
    return (await response.json()) as DataManifest;
  } catch {
    return { mods: [] };
  }
}

/**
 * Monte un dossier de donnees. Les archives sont lues par plages : seul leur
 * catalogue voyage jusqu'au navigateur, pas les centaines de megaoctets.
 */
/** Temps de chaque etape du montage, pour savoir ce qui coute. */
const mountTimings: Record<string, number> = {};

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work();
  mountTimings[label] = Math.round(performance.now() - start);
  return result;
}

async function mountSource(name: string): Promise<void> {
  const mod = manifest.mods.find((entry) => entry.name === name);
  if (!mod) return;

  const mountStart = performance.now();
  overlay.showLoading(`Montage de ${name}`);
  vfs = new VirtualFileSystem();
  shaders = new ShaderLibrary();
  activeSource = name;

  // Les archives s'ouvrent ensemble : seul leur catalogue est lu.
  let done = 0;
  const opened = await timed('archives', () =>
    Promise.all(
      mod.archives.map(async (path) => {
        try {
          const source = await HttpRangeSource.open(path);
          const archive = await Pk3Archive.open(source, path.split('/').pop() ?? path);
          return { path, archive };
        } catch (error) {
          console.warn(`${path} ignore :`, error);
          return { path, archive: null };
        } finally {
          overlay.setProgress(`Montage de ${name}`, ++done, mod.archives.length);
        }
      }),
    ),
  );
  // L'ordre du manifeste fixe la priorite : la derniere archive gagne.
  for (const entry of opened) {
    if (entry.archive) vfs.mount(entry.archive);
  }
  await yieldToBrowser();

  await timed('scripts', () => loadShaderScripts());
  await timed('listes', async () => refreshMaps());
  const fileCount = await timed('comptage', async () => vfs.fileCount);
  mountTimings.acces = HttpRangeSource.reads;
  mountTimings.total = Math.round(performance.now() - mountStart);
  console.log('montage', name, mountTimings);
  overlay.setSources(
    manifest.mods.map((entry) => entry.name),
    activeSource,
  );
  overlay.setNotes(
    `${vfs.mounted.length} archives montees, ${shaders.count} shaders lus, ${fileCount} fichiers, ` +
      `${(mountTimings.total / 1000).toFixed(1)} s.`,
  );
  overlay.showMenu();
}

async function loadShaderScripts(): Promise<void> {
  const scripts = vfs.listByExtension('.shader', 'scripts/');
  overlay.setProgress('Lecture des scripts', 0, scripts.length);

  // Une seule demande pour tous les scripts : le systeme de fichiers groupe
  // les acces par archive et par position, ce qui evite des dizaines de
  // lectures dispersees dans des fichiers de plusieurs centaines de megaoctets.
  const readStart = performance.now();
  const texts = await vfs.readTextMany(scripts);
  const readMs = performance.now() - readStart;

  const parseStart = performance.now();
  let bytes = 0;
  // Les scripts sont ajoutes dans l'ordre du dossier : le premier lu gagne.
  for (const path of scripts) {
    const content = texts.get(path);
    if (!content) continue;
    bytes += content.length;
    try {
      shaders.add(content);
    } catch (error) {
      console.warn(`${path} illisible :`, error);
    }
  }
  const parseMs = performance.now() - parseStart;

  overlay.setProgress('Lecture des scripts', scripts.length, scripts.length);
  await yieldToBrowser();

  mountTimings.scriptsFichiers = scripts.length;
  mountTimings.scriptsLecture = Math.round(readMs);
  mountTimings.scriptsAnalyse = Math.round(parseMs);
  mountTimings.scriptsKo = Math.round(bytes / 1024);
}

function refreshMaps(): void {
  const entries: MapEntry[] = vfs
    .listByExtension('.bsp', 'maps/')
    .map((path) => ({
      path,
      name: path.replace(/^maps\//, '').replace(/\.bsp$/, ''),
      source: activeSource || 'fichiers deposes',
    }))
    // La demonstration ne porte que sur une carte : le reste du catalogue
    // n'est pas propose, pour ne pas laisser croire qu'il est traite.
    .filter((entry) => isFocusMap(entry.name));
  overlay.setMaps(entries);
}

async function playMap(entry: MapEntry): Promise<void> {
  if (busy) return;
  busy = true;
  currentMap = entry;
  try {
    overlay.showLoading(`Chargement de ${entry.name}`);
    await yieldToBrowser();

    const data = await vfs.read(entry.path);
    if (!data) throw new Error('carte introuvable dans les archives montees');

    const level = await loadBspLevel(entry.path, data, vfs, shaders, {
      settings: session.settings.current,
      maxAnisotropy: session.renderer.maxAnisotropy,
      onProgress: (label, done, total) => overlay.setProgress(`${entry.name} : ${label}`, done, total),
    });

    session.setLevel(level);
    session.setPaused(false);
    session.start();
    overlay.showGame();
    showHud(true);
    // Vue reproductible pour comparer les materiaux sans deplacer la camera.
    const shot = params.get('shot');
    if (shot !== null && /^\d+$/.test(shot)) {
      session.settings.patch({ dynamicResolution: false });
      session.benchmark(Number(shot));
    } else {
      session.input.requestLock();
    }
    overlay.notify(
      `${entry.name} : ${level.map.faces.length} faces, ${level.map.brushes.length} volumes, ${level.lights.count} lampes`,
    );
  } catch (error) {
    console.error(error);
    overlay.showMenu();
    overlay.setNotes(`Echec du chargement : ${(error as Error).message}`, true);
  } finally {
    busy = false;
  }
}

function playDemo(): void {
  currentMap = null;
  session.setLevel(buildDemoArena());
  session.setPaused(false);
  session.start();
  overlay.showGame();
  showHud(true);
  session.input.requestLock();
  overlay.notify('Arene de demonstration : aucune donnee du jeu utilisee');
}

/** Le HUD n'a de sens qu'en jeu : il disparait avec le menu. */
function showHud(visible: boolean): void {
  ui.setHudVisible(visible);
}

overlay.onDemo = () => playDemo();
overlay.onSelectMap = (entry) => void playMap(entry);
overlay.onSelectSource = (name) => void mountSource(name);

window.addEventListener('keydown', (event) => {
  // Outils de jugement des materiaux.
  if (event.code === 'F6') {
    event.preventDefault();
    const { mode, converted } = session.cycleComparison();
    const names: Record<string, string> = {
      redux: 'Quake Redux',
      original: 'textures d\'origine',
      split: 'image coupee : origine a gauche, refonte a droite',
    };
    overlay.notify(`${names[mode]} (${converted} surfaces refaites)`);
    return;
  }
  if (event.code === 'F7') {
    event.preventDefault();
    overlay.notify(`carte affichee : ${session.cycleMaterialChannel()}`);
    return;
  }
  if (event.code === 'KeyM') {
    session.input.releaseLock();
    session.setPaused(true);
    overlay.showMenu();
    showHud(false);
  }
  if (event.code === 'KeyR') session.respawn();
  if (event.code === 'KeyG') {
    settingsPanel.toggle();
    // Panneau ouvert : la souris redevient un curseur et le jeu attend.
    if (settingsPanel.isVisible) {
      session.input.releaseLock();
      session.setPaused(true);
    } else {
      session.setPaused(false);
      session.input.requestLock();
    }
  }
});

/** Un reglage prepare au chargement : la carte est reprise depuis le debut. */
settingsPanel.onReloadNeeded = () => {
  if (!currentMap || busy) return;
  const entry = currentMap;
  window.setTimeout(() => {
    settingsPanel.hide();
    void playMap(entry);
  }, 120);
};

// Depot direct d'une archive ou d'une carte, sans passer par public/data.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length === 0) return;

  overlay.showLoading('Lecture des fichiers deposes');
  for (const file of files) {
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.pk3')) {
        vfs.mount(await Pk3Archive.open(new BlobSource(file), file.name));
      } else if (name.endsWith('.bsp')) {
        vfs.addFile(`maps/${name}`, new Uint8Array(await file.arrayBuffer()));
      } else if (name.endsWith('.shader')) {
        shaders.add(new TextDecoder('latin1').decode(await file.arrayBuffer()));
      }
    } catch (error) {
      console.warn(`${file.name} ignore :`, error);
    }
  }
  await loadShaderScripts();
  refreshMaps();
  overlay.setNotes(`${vfs.mounted.length} archives montees, ${shaders.count} shaders lus.`);
  overlay.showMenu();
});

async function boot(): Promise<void> {
  manifest = await readManifest();
  const names = manifest.mods.map((mod) => mod.name);
  overlay.setSources(names, names[0] ?? '');

  if (names.length === 0) {
    overlay.setNotes(
      "Aucune archive detectee. Placez vos .pk3 dans public/data, lancez node tools/scan-data.mjs, ou deposez-les sur cette page. L'arene de demonstration fonctionne sans donnees.",
    );
    overlay.showMenu();
    return;
  }

  // Le dossier de base du jeu passe en premier quand il est la.
  const preferred = params.get('source') ?? (names.includes('baseq3') ? 'baseq3' : names[0]);
  await mountSource(preferred);

  // La carte de la demonstration se lance directement quand elle est la.
  const requested = params.get('map') ?? FOCUS_MAP;
  const entry = { path: `maps/${requested}.bsp`, name: requested, source: activeSource };
  if (vfs.has(entry.path)) await playMap(entry);
}

void boot();
