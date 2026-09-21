"""
Lecture des scripts .shader du jeu.

Une lampe de Quake n'est pas une texture : c'est un script. Il declare la
puissance que le compilateur de cartes a cuite dans les lightmaps
(q3map_surfacelight), parfois l'image dont la couleur moyenne donne la teinte
de la lumiere (q3map_lightimage), et surtout une couche additive, le plus
souvent nommee .blend, qui est la partie lumineuse du dessin. Cette couche est
ce qu'il faut faire briller ; la deviner a la luminance de l'image de base
donne des halos la ou il n'y en a pas.

Le script porte aussi le battement de la lampe, ecrit comme une onde.

Ce module ne fait qu'une chose : lire ces scripts dans les archives et rendre,
pour chaque nom de surface, ce qui sert a fabriquer son emission.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

from scanner import archives

EXTENSION = re.compile(r'\.(tga|jpg|jpeg|png)$', re.I)


@dataclass
class ShaderLight:
    """Ce qu'un script dit de la lumiere d'une surface."""

    name: str
    # Puissance donnee au compilateur de cartes. Zero : la surface n'eclaire pas.
    surface_light: float
    diffuse: str | None
    glow: str | None
    light_image: str | None
    light_rgb: tuple[float, float, float] | None
    wave: tuple[float, float, float, float] | None
    dependencies: tuple[str, ...] = ()

    @property
    def emits(self) -> bool:
        return self.surface_light > 0 or self.glow is not None


def catalogue(data_directory: Path) -> dict[str, ShaderLight]:
    """
    Tous les scripts des archives, dans l'ordre de montage : une archive plus
    recente remplace la definition precedente, comme dans le jeu.
    """
    found: dict[str, ShaderLight] = {}
    for archive in archives(data_directory):
        try:
            with zipfile.ZipFile(archive) as handle:
                names = [entry for entry in handle.namelist() if entry.lower().endswith('.shader')]
                for entry in sorted(names):
                    text = handle.read(entry).decode('latin1')
                    found.update(parse(text))
        except (zipfile.BadZipFile, KeyError):
            continue
    return found


def parse(text: str) -> dict[str, ShaderLight]:
    """Lit un script entier et rend ses definitions lumineuses."""
    # Les commentaires partent d'abord : ils contiennent parfois des accolades.
    text = re.sub(r'//[^\n]*', '', text)
    result: dict[str, ShaderLight] = {}

    position = 0
    length = len(text)
    while position < length:
        # Nom : le premier mot hors bloc.
        match = re.compile(r'[^\s{}]+').search(text, position)
        if not match:
            break
        name = match.group(0).strip().lower().replace('\\', '/')
        opening = text.find('{', match.end())
        if opening < 0:
            break

        depth = 0
        cursor = opening
        while cursor < length:
            if text[cursor] == '{':
                depth += 1
            elif text[cursor] == '}':
                depth -= 1
                if depth == 0:
                    break
            cursor += 1

        body = text[opening + 1: cursor]
        entry = read_block(name, body)
        if entry:
            result[name] = entry
        position = cursor + 1

    return result


def read_block(name: str, body: str) -> ShaderLight | None:
    """Lit un bloc de shader : ses directives, puis ses couches."""
    surface_light = 0.0
    light_image: str | None = None
    light_rgb: tuple[float, float, float] | None = None
    editor_image: str | None = None

    # Les couches sont les blocs internes ; le reste est directive.
    stages: list[str] = []
    depth = 0
    start = 0
    directives: list[str] = []
    for index, character in enumerate(body):
        if character == '{':
            if depth == 0:
                directives.append(body[start:index])
                start = index + 1
            depth += 1
        elif character == '}':
            depth -= 1
            if depth == 0:
                stages.append(body[start:index])
                start = index + 1
    directives.append(body[start:])

    for line in '\n'.join(directives).splitlines():
        words = line.split()
        if not words:
            continue
        keyword = words[0].lower()
        if keyword == 'q3map_surfacelight' and len(words) > 1:
            try:
                surface_light = float(words[1])
            except ValueError:
                surface_light = 0.0
        elif keyword == 'q3map_lightimage' and len(words) > 1:
            light_image = clean_path(words[1])
        elif keyword == 'qer_editorimage' and len(words) > 1:
            editor_image = clean_path(words[1])
        elif keyword in ('q3map_lightrgb', 'q3map_lightsubdivide') and len(words) > 3:
            try:
                light_rgb = (float(words[1]), float(words[2]), float(words[3]))
            except ValueError:
                light_rgb = None

    diffuse: str | None = None
    glow: str | None = None
    wave: tuple[float, float, float, float] | None = None

    dependencies: list[str] = []
    for stage in stages:
        image: str | None = None
        additive = False
        stage_wave: tuple[float, float, float, float] | None = None
        for line in stage.splitlines():
            words = line.split()
            if not words:
                continue
            keyword = words[0].lower()
            if keyword in ('map', 'clampmap', 'animmap'):
                paths = words[2:] if keyword == 'animmap' else words[1:2]
                dependencies.extend(clean_path(path) for path in paths if not path.startswith('$'))
            if keyword in ('map', 'clampmap') and len(words) > 1:
                if words[1].startswith('$'):
                    image = None
                    break
                image = clean_path(words[1])
            elif keyword == 'animmap' and len(words) > 2:
                image = clean_path(words[2])
            elif keyword == 'blendfunc' and len(words) > 1:
                arguments = [word.lower() for word in words[1:]]
                additive = arguments[0] == 'add' or (
                    len(arguments) > 1
                    and arguments[0] == 'gl_one'
                    and arguments[1] in ('gl_one', 'gl_src_alpha')
                )
            elif keyword == 'rgbgen' and len(words) > 5 and words[1].lower() == 'wave':
                try:
                    stage_wave = (float(words[3]), float(words[4]), float(words[5]), float(words[6]))
                except (ValueError, IndexError):
                    stage_wave = None

        if not image:
            continue
        if additive:
            if glow is None:
                glow = image
                wave = stage_wave
        elif diffuse is None:
            diffuse = image

    if diffuse is None:
        diffuse = glow or editor_image

    if surface_light <= 0 and glow is None and diffuse is None:
        return None
    return ShaderLight(
        name=name,
        surface_light=surface_light,
        diffuse=diffuse,
        glow=glow,
        light_image=light_image,
        light_rgb=light_rgb,
        wave=wave,
        dependencies=tuple(dict.fromkeys(dependencies)),
    )


def clean_path(value: str) -> str:
    return EXTENSION.sub('', value.strip().lower().replace('\\', '/'))
