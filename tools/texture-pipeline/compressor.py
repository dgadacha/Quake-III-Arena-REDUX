"""
Compression pour le web.

Les textures sont ecrites deux fois : en PNG, qui reste le format de reference
et sert d'image de repli, et en blocs BC7, qui est ce que le jeu charge quand
la carte graphique sait les lire. Une texture non compressee occupe quatre
octets par pixel en memoire video, un bloc BC7 un seul, et il n'y a rien a
decoder au chargement.

Le conteneur est minuscule et fait maison : douze octets d'entete, puis les
niveaux de mipmap les uns apres les autres. Les formats standards demandent
soit un outil qui n'est pas installe partout, soit un decodeur en plus dans le
navigateur ; ici les deux bouts sont a nous, et le chargeur du jeu tient en
trente lignes.

Les niveaux sont calcules ici plutot que par la carte graphique : une texture
compressee ne peut pas les faire generer a l'execution, ils doivent etre dans
le fichier.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

from PIL import Image

import bc7
from common import to_linear, to_srgb

MAGIC = b'Q3TX'
VERSION = 1
FORMAT_BC7 = 1

# En dessous de cette taille, un niveau tient dans un bloc unique : inutile de
# descendre plus bas, la carte graphique ne lira jamais au-dela.
SMALLEST = 4


def compress(source: Path, normal_map: bool = False, srgb: bool = True) -> Path:
    """
    Ecrit la version compressee d'une image deja enregistree en PNG, et rend le
    chemin du fichier a servir. Le PNG reste sur le disque : c'est lui que le
    jeu charge si la carte graphique ne sait pas lire les blocs.
    """
    image = _read(source)
    target = source.with_suffix('.q3tex')
    levels = [bc7.encode(level) for level in _mipmaps(image, srgb and not normal_map)]

    height, width = image.shape[:2]
    with target.open('wb') as handle:
        handle.write(MAGIC)
        handle.write(struct.pack(
            '<BBBBHH', VERSION, FORMAT_BC7, 1 if srgb else 0, len(levels), width, height,
        ))
        for data in levels:
            handle.write(struct.pack('<I', len(data)))
            handle.write(data)
    return target


def _read(source: Path) -> np.ndarray:
    """
    Lit l'image a compresser en gardant son canal alpha : les textures
    decoupees en ont un, et BC7 sait le porter.
    """
    with Image.open(source) as handle:
        mode = 'RGBA' if handle.mode in ('RGBA', 'LA', 'PA') else 'RGB'
        return np.asarray(handle.convert(mode), dtype=np.float32) / 255.0


def _mipmaps(image: np.ndarray, gamma: bool) -> list[np.ndarray]:
    """
    Suite des niveaux, du plus grand au plus petit, chacun moitie du precedent.

    Une couleur est moyennee en lumiere lineaire : moyenner des valeurs sRGB
    assombrit l'image a chaque niveau, ce qui se voit sur un sol vu de loin. Le
    relief et les cartes de surface, eux, ne sont pas des couleurs et se
    moyennent tels quels.
    """
    levels = [image]
    current = _to_light(image) if gamma else image
    height, width = image.shape[:2]

    while max(width, height) > SMALLEST:
        width, height = max(1, width // 2), max(1, height // 2)
        current = _halve(current)
        levels.append(_to_screen(current) if gamma else current)
    return levels


def _to_light(image: np.ndarray) -> np.ndarray:
    """Vers la lumiere lineaire, sans toucher au canal de decoupe."""
    if image.shape[2] == 4:
        return np.concatenate([to_linear(image[..., :3]), image[..., 3:]], axis=2)
    return to_linear(image)


def _to_screen(image: np.ndarray) -> np.ndarray:
    if image.shape[2] == 4:
        return np.concatenate([to_srgb(image[..., :3]), image[..., 3:]], axis=2)
    return to_srgb(image)


def _halve(image: np.ndarray) -> np.ndarray:
    """Moyenne des quatre pixels de chaque carre, bord impair repete."""
    height, width = image.shape[:2]
    if width % 2:
        image = np.concatenate([image, image[:, -1:]], axis=1)
    if height % 2:
        image = np.concatenate([image, image[-1:, :]], axis=0)
    height, width = image.shape[:2]
    grouped = image.reshape(height // 2, 2, width // 2, 2, image.shape[2])
    return grouped.mean(axis=(1, 3), dtype=np.float32)
