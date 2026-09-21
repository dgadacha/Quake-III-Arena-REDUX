"""
Carte metallique.

Le cahier est net : la part metallique vient de la classification, pas de la
luminosite. Une pierre claire n'est pas du metal, et un metal sombre en est
toujours. Une seule famille demande un masque, celle des textures mixtes, ou
metal et matiere diffuse cohabitent dans la meme image ; le masque s'appuie
alors sur la saturation, car les metaux peints du jeu sont presque gris.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur
from classifier import MaterialType
from profiles import MaterialProfile


def metal_mask(image: np.ndarray, ceiling: float = 0.75) -> np.ndarray:
    """
    Masque de metal nu.

    Une plaque ancienne n'est pas du metal sur toute sa surface : la rouille et
    la peinture sont diffuses, et seules les parties usees renvoient comme du
    metal. Ces parties sont a la fois claires et peu saturees ; la rouille, au
    contraire, est sombre et orangee. Le masque croise donc les deux
    indications, et ce n'est pas la luminosite seule qui decide.
    """
    maximum = image.max(axis=-1)
    minimum = image.min(axis=-1)
    saturation = np.where(maximum > 1e-4, (maximum - minimum) / np.maximum(maximum, 1e-4), 0.0)

    from common import luminance, normalize01

    brightness = normalize01(luminance(image))
    grey = np.clip(1.0 - saturation * 3.2, 0.0, 1.0)
    mask = np.clip(brightness * 0.55 + grey * 0.45, 0.0, 1.0)
    # Adouci : une frontiere pixel par pixel se verrait comme du bruit.
    return gaussian_blur(mask, 1.2) * ceiling


def metalness(image: np.ndarray, material: MaterialProfile, kind: MaterialType) -> np.ndarray | float:
    """
    Part metallique. Rend un nombre quand la matiere est uniforme, et une carte
    quand il faut distinguer deux matieres dans la meme image.
    """
    if kind is not MaterialType.MIXED:
        return material.metalness

    maximum = image.max(axis=-1)
    minimum = image.min(axis=-1)
    saturation = np.where(maximum > 1e-4, (maximum - minimum) / np.maximum(maximum, 1e-4), 0.0)

    # Peu sature : probablement du metal. Le masque est adouci pour ne pas
    # produire de frontiere pixel par pixel.
    mask = np.clip(1.0 - saturation * 4.0, 0.0, 1.0)
    return gaussian_blur(mask, 1.5) * 0.85
