"""
Carte de rugosite.

Une rugosite constante donne une surface en plastique : c'est la variation qui
fait lire une matiere. Trois termes la composent.

La base vient de la matiere. La variation de surface vient du grain de la
texture : ce qui est fin et contraste accroche la lumiere de facon irreguliere,
donc plus mat. L'usure vient des zones sombres et sales, plus mates que les
parties nettes ; sur un metal, au contraire, les reflets peints indiquent les
endroits polis, donc plus lisses.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur, luminance, normalize01, remap, value_noise
from classifier import MaterialType
from profiles import MaterialProfile


def roughness(
    image: np.ndarray,
    material: MaterialProfile,
    kind: MaterialType,
    bounds: tuple[float, float] | None = None,
    variation: float = 0.0,
    seed: int = 1,
) -> np.ndarray:
    """
    Rugosite entre les bornes de la matiere.

    La variation ajoute de grandes taches douces, sans couture : c'est ce qui
    fait qu'un sol n'est pas uniformement mat, que certaines dalles renvoient la
    lumiere des lampes et d'autres pas. Sans elle, une surface entiere repond a
    la lumiere d'un seul bloc, et rien ne se lit.
    """
    lit = luminance(image)

    # Grain local : ecart type sur un petit voisinage.
    mean = gaussian_blur(lit, 1.5)
    variance = np.maximum(gaussian_blur(lit * lit, 1.5) - mean * mean, 0.0)
    grain = normalize01(np.sqrt(variance))

    if kind in (MaterialType.METAL, MaterialType.LIQUID, MaterialType.GLASS):
        # Sur un metal, les zones claires sont les parties polies : elles
        # deviennent lisses, les zones sombres et sales restent mates.
        wear = 1.0 - normalize01(mean)
    else:
        # Sur une matiere diffuse, le clair est plutot la poussiere et le mat.
        wear = normalize01(mean) * 0.5 + 0.5

    mixed = np.clip(wear * 0.65 + grain * 0.35, 0.0, 1.0)

    if variation > 0:
        # Deux echelles : de larges zones, et des taches plus serrees dedans.
        size = image.shape[0]
        large = value_noise(size, 3, octaves=2, seed=seed)
        patches = value_noise(size, 7, octaves=3, seed=seed + 1)
        field = np.clip(large * 0.65 + patches * 0.35, 0.0, 1.0)
        # Centre sur zero : la variation ecarte de part et d'autre du milieu.
        mixed = np.clip(mixed + (field - 0.5) * 2.0 * variation, 0.0, 1.0)

    low, high = bounds if bounds else material.roughness
    return remap(mixed, low, high)
