#!/usr/bin/env python3
"""
Chaine de textures HD.

    npm run textures:generate -- --map q3dm17 --top 8
    npm run textures:generate -- --texture textures/base_floor/diamond2c
    npm run textures:generate -- --category metal
    npm run textures:generate -- --all

Elle lit les textures dans les archives du joueur, sans jamais les copier dans
le depot, et ecrit les materiaux produits dans public/generated/materials, qui
n'est pas suivi par git non plus. Rien de ce qui appartient au jeu ne quitte la
machine.

Chaque texture traverse les memes etapes : classement, nettoyage,
agrandissement, continuite des bords, generation des cartes, validation contre
l'original, compression, inscription au manifeste. Une texture qui echoue a la
validation n'est pas inscrite : le jeu garde son materiau d'origine.
"""

from __future__ import annotations

import argparse
import hashlib
import math
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np

import basecolor
import cleaner
import priorities as priority_table
import shaders as shader_scripts
import compressor
import manifest as manifest_module
import scanner
import seamless
import upscaler
import validator
from aoGenerator import ambient_occlusion
from classifier import MaterialType, classify
from common import load_alpha, load_image, luminance, save_image
from emissiveGenerator import emissive
from heightGenerator import height as height_map
from metalnessGenerator import metal_mask, metalness as metalness_map
from normalGenerator import normal as normal_map
from profiles import profile
from roughnessGenerator import roughness as roughness_map

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'public' / 'data'
OUTPUT = ROOT / 'public' / 'generated' / 'materials'
MANIFEST = OUTPUT / 'manifest.json'

SUFFIXES = {
    'baseColor': '_bc',
    'normal': '_n',
    # Occlusion, rugosite et metal tiennent dans une seule image : un canal
    # chacun, dans l'ordre que Three lit deja. Separees, ces trois cartes a un
    # seul canal arrivaient comme des images HTML et occupaient quatre octets
    # par pixel chacune, soit la moitie de la memoire video de la carte.
    'orm': '_orm',
    'emissive': '_e',
    'height': '_h',
}


@dataclass
class Job:
    """Une surface a traiter : son nom, ses images, et ce que le script en dit."""

    name: str
    diffuse: scanner.SourceTexture
    glow: scanner.SourceTexture | None
    light: shader_scripts.ShaderLight | None


def _scaled(source: tuple[int, int], long_side: int | None) -> tuple[int, int] | None:
    """
    Taille imposee par la table des priorites, ramenee au rapport de la
    texture. La table donne un seul nombre : c'est le cote le plus long.
    """
    if not long_side:
        return None
    width, height = source
    if width >= height:
        return long_side, max(1, round(long_side * height / width))
    return max(1, round(long_side * width / height)), long_side


def process(job: Job, engine: str, keep_height: bool) -> dict | None:
    """Traite une surface et rend son entree de manifeste."""
    import io

    raw = job.diffuse.read()
    image = load_image(io.BytesIO(raw))
    # Decoupe de la texture d'origine, quand elle en a une. Une grille dont on
    # perd l'alpha devient un mur.
    cutout = load_alpha(io.BytesIO(raw))
    declared = job.light.surface_light if job.light else 0.0
    rule = priority_table.priority(job.name)
    # Une surface peut imposer son moteur : voir la table des priorites.
    if rule.engine:
        engine = rule.engine if rule.engine in upscaler.available_engines() else engine
    # Une surface que le script declare lumineuse l'est : cela passe avant le
    # nom du dossier, qui n'est qu'une indication. Une matiere imposee par la
    # table des priorites passe avant tout le reste.
    kind = (
        rule.kind
        or (MaterialType.EMISSIVE if declared > 0 or (job.light and job.light.glow) else classify(job.name))
    )
    material = profile(kind)

    # Nettoyage, dose d'apres le bruit mesure : une texture propre n'est pas
    # touchee, une texture tres compressee l'est franchement.
    noise = cleaner.grain_level(image)
    # Le reseau d'agrandissement debruite deja : nettoyer fort avant lui
    # retirerait de la matiere qu'il aurait su garder.
    prepare = 0.45 if engine == 'esrgan' else 1.0
    strength = min(1.4, noise / 0.006) * rule.clean * prepare
    cleaned = cleaner.clean(image, strength)
    # Grain restant : c'est la mesure qui dit si la texture a vraiment perdu
    # son bruit de compression, plutot que l'impression devant l'ecran.
    residual = cleaner.grain_level(cleaned)

    source = (image.shape[1], image.shape[0])
    size = _scaled(source, rule.base) or upscaler.target_size(*source)
    enlarged = upscaler.upscale(cleaned, size, engine)

    map_size = _scaled(source, rule.maps) or size
    surface = enlarged if map_size == size else upscaler.upscale(cleaned, map_size, engine)

    # Continuite des bords : on ne corrige que si l'agrandissement a fait
    # moins bien que l'original.
    before = seamless.seam_error(image)
    after = seamless.seam_error(enlarged)
    repaired = any(a > b + 0.01 for a, b in zip(after, before))
    if repaired:
        enlarged = seamless.repair(enlarged)
        after = seamless.seam_error(enlarged)

    neutralize = rule.neutralize if rule.neutralize is not None else material.neutralize
    base = basecolor.neutralize(enlarged, neutralize)

    detail = rule.detail if rule.detail is not None else material.detail
    shaped = replace(material, detail=detail)
    relief = height_map(surface, shaped)
    normals = normal_map(relief, shaped)
    rough = roughness_map(
        surface,
        shaped,
        kind,
        bounds=rule.roughness,
        variation=rule.variation,
        seed=int.from_bytes(hashlib.sha256(job.name.encode()).digest()[:4], 'little') % 10_000,
    )
    metal = metal_mask(surface) if rule.metal_mask else metalness_map(surface, shaped, kind)
    occlusion = ambient_occlusion(relief, shaped)
    glow = emissive(enlarged, kind)

    verdict = validator.validate(image, base)
    if not verdict['passed']:
        print(f"  refuse  {job.name}  {verdict}")
        return None

    directory = OUTPUT / Path(job.name).parent
    directory.mkdir(parents=True, exist_ok=True)
    stem = Path(job.name).name

    produced: dict[str, str] = {}
    packed: dict[str, str] = {}

    def write(key: str, data: np.ndarray, normal_mode: bool = False) -> None:
        """
        Ecrit une carte en PNG, puis sa version compressee. Le jeu charge la
        seconde quand la carte graphique sait lire les blocs, et le PNG sinon.
        Seules la couleur et l'emission sont des couleurs : le relief et la
        carte de surface portent des nombres, et se moyennent tels quels.
        """
        path = directory / f"{stem}{SUFFIXES[key]}.png"
        save_image(data, path)
        relative = lambda file: str(file.relative_to(ROOT / 'public')).replace('\\', '/')
        produced[key] = relative(path)
        served = compressor.compress(
            path, normal_map=normal_mode, srgb=key in ('baseColor', 'emissive'),
        )
        if served != path:
            packed[key] = relative(served)

    if cutout is not None:
        opacity = upscaler.upscale(cutout[..., None].repeat(3, axis=2), size, 'lanczos')[..., :1]
        base = np.concatenate([base, opacity], axis=2)
    write('baseColor', base)
    write('normal', normals, normal_mode=True)
    # Occlusion, rugosite, metal. Quand la part metallique est une constante,
    # le canal reste a un et c'est le materiau qui la porte.
    write('orm', np.stack([
        occlusion,
        rough,
        metal if isinstance(metal, np.ndarray) else np.ones_like(rough),
    ], axis=-1))
    if keep_height:
        write('height', relief)

    emission = None
    if job.glow is not None:
        # La couche lumineuse du script est la vraie carte d'emission : elle
        # est agrandie comme la couleur, sans neutralisation ni relief.
        raw_glow = load_image(io.BytesIO(job.glow.read()))
        glow_map = upscaler.upscale(cleaner.clean(raw_glow, 0.6), size, engine)
        write('emissive', glow_map)
        emission = describe_emission(declared, glow_map, job)
    elif glow is not None:
        write('emissive', glow)
        emission = describe_emission(declared, glow, job)
    elif declared > 0:
        emission = describe_emission(declared, enlarged, job)

    return manifest_module.entry(
        kind=kind.value,
        resolution=size,
        map_resolution=map_size,
        source_resolution=source,
        engine=engine if max(size) > max(source) else 'copie',
        maps=produced,
        compressed=packed,
        metalness=float(material.metalness) if not isinstance(metal, np.ndarray) else -1.0,
        normal_strength=material.normal_strength,
        roughness_multiplier=1.0,
        seamless=max(after) <= max(max(before), 0.05) + 0.01,
        validation=verdict,
        emission=emission,
        noise={'source': round(noise, 5), 'clean': round(residual, 5)},
    )


def describe_emission(declared: float, glow: np.ndarray, job: Job) -> dict:
    """
    Ce que le jeu doit savoir de l'emission d'une surface.

    La teinte est la couleur moyenne de la partie lumineuse, ponderee par sa
    luminosite : c'est ainsi que le compilateur de cartes donne sa couleur a
    une lampe, et non par une valeur ecrite a la main. La puissance declaree,
    elle, a deja servi a cuire les lightmaps : elle ne dit pas combien la
    surface doit briller a l'ecran, seulement qu'elle brille et a quel point
    elle domine. Une echelle logarithmique garde donc les grosses lampes a
    peine plus vives que les petites.
    """
    weights = luminance(glow)
    total = float(weights.sum())
    if total > 1e-4:
        color = [float((glow[..., channel] * weights).sum() / total) for channel in range(3)]
        peak = max(color) or 1.0
        color = [value / peak for value in color]
    else:
        color = [1.0, 1.0, 1.0]

    if job.light and job.light.light_rgb:
        color = list(job.light.light_rgb)

    intensity = 0.0
    if declared > 0:
        intensity = min(2.4, 0.5 + math.log10(max(10.0, declared)) / 2.2)
    elif job.light and job.light.glow:
        intensity = 0.8

    wave = None
    if job.light and job.light.wave:
        base, amplitude, phase, frequency = job.light.wave
        wave = {'base': base, 'amplitude': amplitude, 'phase': phase, 'frequency': frequency}

    return {
        'declared': declared,
        'intensity': round(intensity, 3),
        'color': [round(value, 4) for value in color],
        'wave': wave,
    }


def resolve(
    name: str,
    images: dict[str, scanner.SourceTexture],
    lights: dict[str, shader_scripts.ShaderLight],
) -> Job | None:
    """
    Trouve les images d'une surface.

    Une lampe de Quake n'a pas d'image a son nom : c'est un script, qui nomme
    une image de base et une couche lumineuse. On suit donc le script quand le
    nom ne designe pas directement un fichier, et c'est ainsi que les lampes,
    les flammes et les ecrans entrent dans la chaine.
    """
    light = lights.get(name)
    diffuse = images.get(name)
    if diffuse is None and light and light.diffuse:
        diffuse = images.get(light.diffuse)
    if diffuse is None:
        return None

    glow = None
    if light and light.glow and light.glow != light.diffuse:
        glow = images.get(light.glow)

    return Job(name=name, diffuse=diffuse, glow=glow, light=light)


def selection(
    arguments,
    images: dict[str, scanner.SourceTexture],
    lights: dict[str, shader_scripts.ShaderLight],
) -> list[Job]:
    """Surfaces a traiter, d'apres les options de la ligne de commande."""
    if arguments.texture:
        chosen: list[Job] = []
        for name in arguments.texture:
            key = name if name in images or name in lights else f'textures/{name}'
            job = resolve(key, images, lights)
            if not job:
                print(f"inconnue : {name}")
                continue
            chosen.append(job)
        return chosen

    if arguments.map:
        bsp = scanner.read_map(DATA, arguments.map)
        if not bsp:
            print(f"carte introuvable : {arguments.map}")
            return []
        chosen = []
        for name, area, faces in scanner.map_materials(bsp):
            emitting = name in lights
            if arguments.lights and not emitting:
                continue
            # Les surfaces lumineuses comptent quelle que soit leur taille :
            # une lampe de deux faces fait l'ambiance d'une salle entiere.
            if not arguments.lights and len(chosen) >= arguments.top and not emitting:
                continue
            if len(chosen) >= arguments.top and not emitting:
                break
            # Le ciel n'est pas une surface de decor : il a son propre rendu.
            if name.startswith('textures/skies'):
                continue
            job = resolve(name, images, lights)
            if not job:
                continue
            declared = job.light.surface_light if job.light else 0
            lamp = f" lampe {declared:.0f}" if declared else ''
            print(f"  {area / 1e6:7.3f} Mu2 {faces:5d} faces  {classify(name).value:9s}{lamp}  {name}")
            chosen.append(job)
        return chosen

    if arguments.category:
        return [
            job
            for name in sorted(images)
            if classify(name).value == arguments.category
            for job in [resolve(name, images, lights)]
            if job
        ]

    if arguments.all:
        return [job for name in sorted(images) for job in [resolve(name, images, lights)] if job]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description='Chaine de textures HD de Quake Redux')
    parser.add_argument('--all', action='store_true', help='toutes les textures des archives')
    parser.add_argument('--texture', action='append', help='une texture, par son nom')
    parser.add_argument('--category', help='une famille de matiere, par exemple metal')
    parser.add_argument('--map', help='les textures d\'une carte, les plus visibles d\'abord')
    parser.add_argument('--top', type=int, default=12, help='nombre de textures retenues pour une carte')
    parser.add_argument(
        '--lights',
        action='store_true',
        help="ne traite que les surfaces que les scripts declarent lumineuses",
    )
    parser.add_argument('--engine', default='lanczos', choices=upscaler.ENGINES)
    parser.add_argument('--keep-height', action='store_true', help='ecrit aussi la carte de relief')
    parser.add_argument('--force', action='store_true', help='refait meme ce qui existe deja')
    arguments = parser.parse_args()

    if not DATA.exists():
        print('aucun dossier de donnees : public/data est vide')
        return 1

    engines = upscaler.available_engines()
    if arguments.engine not in engines:
        print(f"moteur {arguments.engine} absent de cette machine ; repli sur lanczos")
        arguments.engine = 'lanczos'

    started = time.time()
    images = scanner.catalogue(DATA)
    lights = shader_scripts.catalogue(DATA)
    print(
        f"{len(images)} textures et {len(lights)} surfaces lumineuses dans les archives,"
        f" moteurs : {', '.join(engines)}"
    )

    print('compression : blocs BC7 ecrits a cote de chaque png')

    chosen = selection(arguments, images, lights)
    if not chosen:
        parser.print_help()
        return 1

    entries = manifest_module.load(MANIFEST)
    done = 0
    for job in chosen:
        if job.name in entries and not arguments.force:
            print(f"  deja fait {job.name}")
            continue
        start = time.time()
        result = process(job, arguments.engine, arguments.keep_height)
        if result:
            entries[job.name] = result
            done += 1
            emission = result.get('emission')
            glow = f"  emission {emission['intensity']}" if emission else ''
            noise = result.get('noise')
            grain = f"  bruit {noise['source']:.4f} -> {noise['clean']:.4f}" if noise else ''
            print(
                f"  {job.name}  {result['sourceResolution']} -> {result['resolution']}"
                f" / {result['mapResolution']}  ssim {result['validation']['ssim']}"
                f"{grain}{glow}  {time.time() - start:.1f}s"
            )

    manifest_module.save(MANIFEST, entries)
    print(f"{done} materiaux produits en {time.time() - started:.1f}s, manifeste : {MANIFEST}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
