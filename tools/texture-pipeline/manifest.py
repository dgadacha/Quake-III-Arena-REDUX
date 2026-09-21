"""
Manifeste des materiaux produits.

Le jeu ne devine rien : il lit ce fichier, y trouve les cartes disponibles pour
une texture donnee et les valeurs qui les accompagnent. Une texture absente du
manifeste garde son materiau d'origine, ce qui permet de convertir la carte
materiau par materiau sans jamais casser le rendu.
"""

from __future__ import annotations

import json
from pathlib import Path


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}


def save(path: Path, entries: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = {name: entries[name] for name in sorted(entries)}
    path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + '\n')


def entry(
    *,
    kind: str,
    resolution: tuple[int, int],
    map_resolution: tuple[int, int],
    maps: dict[str, str],
    compressed: dict[str, str] | None = None,
    metalness: float,
    normal_strength: float,
    roughness_multiplier: float,
    seamless: bool,
    validation: dict,
    source_resolution: tuple[int, int],
    engine: str,
    emission: dict | None = None,
    noise: dict | None = None,
) -> dict:
    """
    Une entree du manifeste, telle que le chargeur du jeu l'attend.

    Les tailles sont donnees en couple largeur-hauteur, les textures du jeu
    n'etant pas toutes carrees. Le nombre seul, garde a cote, est le cote le
    plus long : c'est lui qui dit d'un coup d'oeil ce que la surface a gagne.
    """
    entry: dict = {
        'type': kind,
        'resolution': max(resolution),
        'size': list(resolution),
        'mapResolution': max(map_resolution),
        'mapSize': list(map_resolution),
        'sourceResolution': max(source_resolution),
        'sourceSize': list(source_resolution),
        'engine': engine,
        'maps': maps,
        'metalness': metalness,
        'normalStrength': normal_strength,
        'roughnessMultiplier': roughness_multiplier,
        'seamless': seamless,
        'validation': validation,
    }
    # L'emission n'est inscrite que pour les surfaces qui en ont une : le jeu
    # ne doit pas faire briller ce que le script ne declare pas.
    # Versions compressees, quand la chaine a su les ecrire. Le jeu preferera
    # celles-la, et retombera sur les PNG si la carte graphique ne suit pas.
    if compressed:
        entry['compressed'] = compressed
    if emission:
        entry['emission'] = emission
    if noise:
        entry['noise'] = noise
    return entry
