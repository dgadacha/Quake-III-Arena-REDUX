"""
Classement des textures par nature de matiere.

C'est la piece qui decide de tout ce qui suit : une plaque de metal et un mur
de pierre ne recoivent ni la meme rugosite, ni le meme relief, ni la meme part
metallique. Le jeu ne declare pas cette information, mais il la donne
indirectement : ses textures sont rangees par famille, et leurs noms disent la
matiere.

La classification par apprentissage reste possible plus tard ; elle viendrait
completer cette table, pas la remplacer, car une table lisible se corrige a la
main quand une texture tombe dans la mauvaise famille.
"""

from __future__ import annotations

from enum import Enum


class MaterialType(str, Enum):
    STONE = 'stone'
    CONCRETE = 'concrete'
    METAL = 'metal'
    WOOD = 'wood'
    GLASS = 'glass'
    ORGANIC = 'organic'
    FABRIC = 'fabric'
    LIQUID = 'liquid'
    EMISSIVE = 'emissive'
    MIXED = 'mixed'


# Familles de dossiers du jeu. Le premier motif trouve gagne.
DIRECTORY_RULES: tuple[tuple[str, MaterialType], ...] = (
    ('textures/liquids', MaterialType.LIQUID),
    ('textures/skies', MaterialType.MIXED),
    ('textures/base_light', MaterialType.EMISSIVE),
    ('textures/gothic_light', MaterialType.EMISSIVE),
    ('textures/base_floor', MaterialType.METAL),
    ('textures/base_wall', MaterialType.METAL),
    ('textures/base_trim', MaterialType.METAL),
    ('textures/base_support', MaterialType.METAL),
    ('textures/base_door', MaterialType.METAL),
    ('textures/base_button', MaterialType.METAL),
    ('textures/ctf', MaterialType.METAL),
    ('textures/gothic_block', MaterialType.STONE),
    ('textures/gothic_wall', MaterialType.STONE),
    ('textures/gothic_floor', MaterialType.STONE),
    ('textures/gothic_ceiling', MaterialType.STONE),
    ('textures/gothic_trim', MaterialType.METAL),
    ('textures/organics', MaterialType.ORGANIC),
    ('textures/stone', MaterialType.STONE),
    ('textures/skin', MaterialType.ORGANIC),
    ('textures/sfx', MaterialType.EMISSIVE),
)

# Mots des noms de fichiers, plus precis que le dossier quand ils apparaissent.
NAME_RULES: tuple[tuple[str, MaterialType], ...] = (
    # Le metal d'abord : « metfloor_block » est une plaque, pas un bloc.
    ('metal', MaterialType.METAL),
    ('metfloor', MaterialType.METAL),
    ('steel', MaterialType.METAL),
    ('iron', MaterialType.METAL),
    ('pewter', MaterialType.METAL),
    ('diamond', MaterialType.METAL),
    ('grate', MaterialType.METAL),
    ('glass', MaterialType.GLASS),
    ('window', MaterialType.GLASS),
    ('wood', MaterialType.WOOD),
    ('plank', MaterialType.WOOD),
    ('concrete', MaterialType.CONCRETE),
    ('stucco', MaterialType.CONCRETE),
    ('cement', MaterialType.CONCRETE),
    ('brick', MaterialType.STONE),
    ('block', MaterialType.STONE),
    ('rock', MaterialType.STONE),
    ('sand', MaterialType.STONE),
    ('dirt', MaterialType.ORGANIC),
    ('flesh', MaterialType.ORGANIC),
    ('lava', MaterialType.LIQUID),
    ('water', MaterialType.LIQUID),
    ('slime', MaterialType.LIQUID),
    ('light', MaterialType.EMISSIVE),
    ('lamp', MaterialType.EMISSIVE),
    ('glow', MaterialType.EMISSIVE),
    ('screen', MaterialType.EMISSIVE),
    ('metal', MaterialType.METAL),
    ('met', MaterialType.METAL),
    ('steel', MaterialType.METAL),
    ('iron', MaterialType.METAL),
    ('rust', MaterialType.METAL),
    ('pewter', MaterialType.METAL),
    ('grate', MaterialType.METAL),
    ('diamond', MaterialType.METAL),
    ('plate', MaterialType.METAL),
)


def classify(name: str, override: str | None = None) -> MaterialType:
    """Nature de la matiere d'une texture, d'apres son dossier et son nom."""
    if override:
        return MaterialType(override)

    lowered = name.lower()
    base = lowered.rsplit('/', 1)[-1]

    # Le nom du fichier passe avant le dossier : un « glass » dans base_wall
    # reste du verre.
    for word, kind in NAME_RULES:
        if word in base:
            return kind
    for directory, kind in DIRECTORY_RULES:
        if lowered.startswith(directory):
            return kind
    return MaterialType.MIXED
