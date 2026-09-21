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
    resolution: int,
    map_resolution: int,
    maps: dict[str, str],
    metalness: float,
    normal_strength: float,
    roughness_multiplier: float,
    seamless: bool,
    validation: dict,
    source_resolution: int,
    engine: str,
    emission: dict | None = None,
    noise: dict | None = None,
) -> dict:
    """Une entree du manifeste, telle que le chargeur du jeu l'attend."""
    entry: dict = {
        'type': kind,
        'resolution': resolution,
        'mapResolution': map_resolution,
        'sourceResolution': source_resolution,
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
    if emission:
        entry['emission'] = emission
    if noise:
        entry['noise'] = noise
    return entry
