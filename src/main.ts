import { BlobSource, HttpRangeSource, Pk3Archive, VirtualFileSystem } from './formats/pk3';
import { ShaderLibrary } from './formats/shader';
import { buildDemoArena } from './game/demo/arena';
import { FOCUS_MAP, isFocusMap } from './game/focus';
import { loadBspLevel } from './game/bspLevel';
import { Session } from './game/session';
import { Overlay, type MapEntry } from './ui/overlay';
import { MainMenu } from './ui/menu/MainMenu';
import { SettingsPanel } from './ui/SettingsPanel';
import { BenchmarkScreen } from './ui/BenchmarkScreen';
import { UIManager } from './ui/core/UIManager';
import { createHud } from './ui/hud/Hud';

/** Version affichee au bas du menu. */
const BUILD = '0.1.0';

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
const benchScreen = new BenchmarkScreen(overlayRoot);
const menu = new MainMenu(overlayRoot, BUILD, session.settings);
const params = new URLSearchParams(location.search);
/** Derniere carte jouee : un reglage de chargement demande de la reprendre. */
let currentMap: MapEntry | null = null;
/**
 * Ou en est le joueur. Le menu, le jeu et le banc de mesure ne repondent pas
 * de la meme facon aux reglages ni aux touches : c'est cet etat qui tranche,
 * plutot que de deviner d'apres ce qui est affiche.
 */
let mode: 'menu' | 'game' | 'bench' | 'report' = 'menu';
/** Un reglage a change pendant le banc : la carte doit etre reprise. */
let reloadPending = false;

interface DataManifest {
  mods: { name: string; archives: string[] }[];
}

let manifest: DataManifest = { mods: [] };
/** Resume des archives montees, remis au pied du menu apres un chargement. */
let sourceSummary = '';
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
  textures: () => session.textureBudget(),
  /** Nomme la surface visee a un point de l'ecran, de moins un a un. */
  pick: (x = 0, y = 0) => session.pick(x, y),
  place: (x: number, y: number, z: number, yaw = 0, pitch = 0) => session.place(x, y, z, yaw, pitch),
  /**
   * Panneau detaille : les soixante vis de reglage du rendu, etalonnage
   * compris. Il sert a mettre l'image au point, pas a jouer, et n'est donc
   * plus dans le menu.
   */
  tuning: () => settingsPanel.toggle(),
  /** Essaie un point de vue pour le fond du menu, en degres. */
  menuView: (x: number, y: number, z: number, yaw = 0, pitch = 0) => {
    session.leaveMenuView();
    session.enterMenuView({
      origin: [x, y, z],
      yaw: (yaw * Math.PI) / 180,
      pitch: (pitch * Math.PI) / 180,
    });
  },
  /**
   * Compare une carte compressee a son PNG, en la dessinant. Sans argument,
   * prend la premiere carte du manifeste qui existe dans les deux formats.
   */
  compression: async (name?: string) => {
    const { compareCompression } = await import('./renderer/debug/CompressionCheck');
    const { hdMaterials } = await import('./renderer/materials/HDMaterialLoader');
    await hdMaterials.open();
    const chosen = name ?? hdMaterials.names.find((candidate) => {
      const entry = hdMaterials.entry(candidate);
      return entry?.compressed?.baseColor && entry.maps.baseColor;
    });
    const entry = chosen ? hdMaterials.entry(chosen) : null;
    if (!entry?.compressed?.baseColor || !entry.maps.baseColor) return 'no compressed map available';
    const report = await compareCompression(
      session.renderer.webgl,
      entry.maps.baseColor,
      entry.compressed.baseColor,
    );
    return { name: chosen, lisible: hdMaterials.compressionAvailable, ...report };
  },
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
  announce(`Mounting ${name}`);
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
          progress(`Mounting ${name}`, ++done, mod.archives.length);
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
  menu.setSources(
    manifest.mods.map((entry) => entry.name),
    activeSource,
  );
  sourceSummary = `${vfs.mounted.length} archives · ${shaders.count} shaders · ${fileCount} files`;
  menu.setNotes(sourceSummary);
  showMenu();
}

async function loadShaderScripts(): Promise<void> {
  const scripts = vfs.listByExtension('.shader', 'scripts/');
  progress('Reading shader scripts', 0, scripts.length);

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

  progress('Reading shader scripts', scripts.length, scripts.length);
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
  menu.setMap(entries[0]?.name ?? null);
  currentMap = entries[0] ?? currentMap;
}

/**
 * Charge une carte et entre en jeu. En mode silencieux, la carte est
 * seulement montee : c'est ce qu'il faut avant un banc de mesure, ou la vue
 * ne doit pas passer par le jeu.
 */
async function playMap(entry: MapEntry, silent = false): Promise<void> {
  if (busy) return;
  busy = true;
  currentMap = entry;
  try {
    // Le menu s'efface avant le chargement : sinon il reste par-dessus la
    // barre de progression pendant les dix secondes que prend la carte.
    if (!silent) menu.hide();
    announce(`Loading ${entry.name}`);
    await yieldToBrowser();

    const data = await vfs.read(entry.path);
    if (!data) throw new Error('map not found in the mounted archives');

    const level = await loadBspLevel(entry.path, data, vfs, shaders, {
      settings: session.settings.current,
      maxAnisotropy: session.renderer.maxAnisotropy,
      onProgress: (label, done, total) => progress(`${entry.name} · ${label}`, done, total),
    });

    session.setLevel(level);
    session.leaveMenuView();
    session.setPaused(false);
    session.start();
    reloadPending = false;
    if (silent) return;
    menu.hide();
    mode = 'game';
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
      `${entry.name}: ${level.map.faces.length} faces, ${level.map.brushes.length} brushes, ${level.lights.count} lights`,
    );
  } catch (error) {
    console.error(error);
    showMenu();
    menu.setNotes(`Loading failed: ${(error as Error).message}`, true);
  } finally {
    busy = false;
  }
}

function playDemo(): void {
  currentMap = null;
  session.leaveMenuView();
  menu.hide();
  mode = 'game';
  session.setLevel(buildDemoArena());
  session.setPaused(false);
  session.start();
  overlay.showGame();
  showHud(true);
  session.input.requestLock();
  overlay.notify('Test arena: no game data used');
}

/**
 * Annonce une etape de chargement.
 *
 * Tant que le menu est a l'ecran, elle passe par la ligne discrete de son pied
 * de page : l'ecran de chargement, lui, apparaitrait derriere le menu, dont le
 * fond est translucide, et on verrait la barre a travers les entrees.
 */
function announce(label: string): void {
  if (menu.isVisible) menu.setNotes(label.toLowerCase());
  else overlay.showLoading(label);
}

/** Avancement d'une etape, au meme endroit que son annonce. */
function progress(label: string, done: number, total: number): void {
  if (menu.isVisible) {
    menu.setNotes(total > 1 ? `${label.toLowerCase()} · ${done}/${total}` : label.toLowerCase());
    return;
  }
  overlay.setProgress(label, done, total);
}

/** Le HUD n'a de sens qu'en jeu : il disparait avec le menu. */
function showHud(visible: boolean): void {
  ui.setHudVisible(visible);
}

menu.onSource = (name) => void mountSource(name);
menu.onSelect = (page, entry) => {
  if (page === 'single' && entry === 'start') void playFocusMap();
  else if (entry === 'benchmark') void startBenchmark();
  else if (entry === 'arena') playDemo();
};

/*
 * Un reglage prepare au chargement. La carte n'est pas reprise sur le champ :
 * on regle souvent plusieurs crans de suite, et chacun rechargerait la carte.
 * Elle l'est en fermant les reglages, ou au prochain lancement.
 */
menu.onReload = () => {
  reloadPending = true;
};

menu.onClose = () => closeGameSettings();

/**
 * Menu a l'ecran, avec le decor rendu derriere lui quand la carte est deja
 * montee. C'est ce qui fait le lien entre le menu et la demonstration : on
 * voit l'arene, presque noire, avant d'y entrer.
 */
function showMenu(): void {
  mode = 'menu';
  overlay.showMenu();
  showHud(false);
  menu.show();
  session.enterMenuView();
}

benchScreen.onRepeat = () => void startBenchmark();
benchScreen.onSettings = () => {
  benchScreen.hide();
  showMenu();
  menu.openSettings();
};
benchScreen.onMenu = () => backToMenu();

/** Carte mise en avant par le menu : celle de la demonstration. */
function focusEntry(): MapEntry {
  const requested = params.get('map') ?? FOCUS_MAP;
  return { path: `maps/${requested}.bsp`, name: requested, source: activeSource };
}

async function playFocusMap(): Promise<void> {
  await playMap(currentMap ?? focusEntry());
}

/**
 * Banc de mesure. La carte est montee si elle ne l'est pas deja, puis la
 * camera parcourt le decor et chaque image est comptee. Rien n'est joue
 * pendant ce temps : le resultat doit dependre des reglages, pas du joueur.
 */
async function startBenchmark(): Promise<void> {
  if (busy || session.benchmarking) return;
  settingsPanel.hide();

  const entry = currentMap ?? focusEntry();
  if (!session.currentLevel || reloadPending || currentMap?.path !== entry.path) {
    await playMap(entry, true);
    if (!session.currentLevel) {
      overlay.showMenu();
      mode = 'menu';
      return;
    }
  }

  mode = 'bench';
  menu.hide();
  session.leaveMenuView();
  benchScreen.hide();
  overlay.showScene();
  showHud(false);

  const report = await session.runBenchmark((info) => benchScreen.update(info));
  benchScreen.hideRunning();
  if (!report) {
    backToMenu();
    return;
  }
  mode = 'report';
  benchScreen.show(report);
  console.log('banc de mesure', report);
}

/**
 * Referme les reglages ouverts en partie. Un reglage prepare au chargement
 * demande de reprendre la carte : elle est rechargee a ce moment, et pas
 * pendant qu'on la regle, pour ne pas la recharger a chaque cran.
 */
function closeGameSettings(): void {
  menu.hide();
  if (reloadPending && currentMap) {
    void playMap(currentMap);
    return;
  }
  session.setPaused(false);
  session.input.requestLock();
}

/** Retour au menu, quel que soit l'etat en cours. */
function backToMenu(): void {
  session.cancelBenchmark();
  settingsPanel.hide();
  benchScreen.hide();
  session.input.releaseLock();
  session.setPaused(true);
  showMenu();
}

window.addEventListener('keydown', (event) => {
  // Outils de jugement des materiaux.
  if (event.code === 'F6') {
    event.preventDefault();
    const { mode, converted } = session.cycleComparison();
    const names: Record<string, string> = {
      redux: 'Quake Redux',
      original: 'original textures',
      split: 'split view: original left, redux right',
    };
    overlay.notify(`${names[mode]} (${converted} surfaces rebuilt)`);
    return;
  }
  if (event.code === 'F7') {
    event.preventDefault();
    overlay.notify(`map channel shown: ${session.cycleMaterialChannel()}`);
    return;
  }
  // Echap pendant un essai l'interrompt : c'est la seule sortie, la souris
  // n'etant pas prise par le jeu a ce moment.
  if (event.code === 'Escape' && mode === 'game' && menu.isVisible) {
    event.preventDefault();
    closeGameSettings();
    return;
  }
  if (event.code === 'Escape' && (mode === 'bench' || mode === 'report')) {
    event.preventDefault();
    backToMenu();
    return;
  }
  if (event.code === 'KeyM' && mode !== 'menu') {
    backToMenu();
    return;
  }
  if (event.code === 'KeyR' && mode === 'game') session.respawn();
  /*
   * Reglages en cours de partie : la meme page que dans le menu, posee par
   * dessus le jeu, qui attend pendant ce temps.
   */
  if (event.code === 'KeyG' && mode === 'game') {
    event.preventDefault();
    if (menu.isVisible) closeGameSettings();
    else {
      menu.openSettings();
      session.input.releaseLock();
      session.setPaused(true);
    }
  }
});

/** Un reglage prepare au chargement : la carte est reprise depuis le debut. */
settingsPanel.onReloadNeeded = () => {
  if (!currentMap || busy) return;
  /*
   * Hors du jeu, la carte n'est pas reprise sur le champ : depuis le resultat
   * d'un essai, cela ferait disparaitre les chiffres qu'on vient de lire. Elle
   * sera rechargee au prochain essai ou au prochain lancement.
   */
  if (mode !== 'game') {
    reloadPending = true;
    return;
  }
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

  announce('Reading dropped files');
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
  sourceSummary = `${vfs.mounted.length} archives · ${shaders.count} shaders`;
  menu.setNotes(sourceSummary);
  showMenu();
});

async function boot(): Promise<void> {
  manifest = await readManifest();
  const names = manifest.mods.map((mod) => mod.name);
  // Le dossier de base du jeu passe en premier quand il est la : c'est lui
  // qui sera monte, et c'est donc lui que le menu doit montrer comme actif.
  const preferred = params.get('source') ?? (names.includes('baseq3') ? 'baseq3' : names[0]);
  menu.setSources(names, preferred);
  // Le menu est la des la premiere image, sur fond noir : le decor ne le
  // rejoint qu'une fois la carte montee.
  menu.show();
  menu.setMap(null);

  if (names.length === 0) {
    menu.setNotes(
      'No archive detected. Put your .pk3 files in public/data, run node tools/scan-data.mjs, or drop them on this page. The test arena works without game data.',
    );
    return;
  }

  await mountSource(preferred);

  /*
   * Le menu s'affiche d'abord : lancer la demonstration, la mesurer ou regler
   * le rendu sont trois entrees, et rien ne demarre sans qu'on le demande.
   * Les outils de mise au point, eux, passent par l'adresse et veulent la
   * carte tout de suite.
   */
  const entry = focusEntry();
  if (!vfs.has(entry.path)) return;
  currentMap = entry;
  if (params.has('shot') || params.has('map') || params.has('play')) {
    await playMap(entry);
    return;
  }

  /*
   * La carte est montee sans entrer en partie : elle sert de decor au menu, et
   * l'entree en jeu est ensuite immediate.
   */
  await playMap(entry, true);
  menu.setNotes(sourceSummary);
  showMenu();
}

void boot();
