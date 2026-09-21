"""
Occlusion ambiante.

Elle ne remplace pas l'occlusion calculee a l'image : elle decrit ce que la
geometrie ne connait pas, les creux du relief, les joints entre les blocs, le
pourtour des rivets. Elle reste legere, pour deux raisons : la lightmap du jeu
porte deja l'occlusion des grands volumes, et le rendu ajoute la sienne.

Le principe est celui de l'occlusion par hauteur : un point plus bas que son
voisinage recoit moins de lumiere.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur
from profiles import MaterialProfile


def ambient_occlusion(height: np.ndarray, material: MaterialProfile) -> np.ndarray:
    """Occlusion deduite du relief, entre zero et un."""
    # Deux echelles : les creux larges et les creux fins.
    wide = gaussian_blur(height, max(3.0, height.shape[0] / 64.0))
    fine = gaussian_blur(height, 1.5)

    hollow = np.clip((wide - height) * 2.2 + (fine - height) * 1.4, 0.0, 1.0)
    occlusion = 1.0 - hollow * material.ao
    # Plancher : une occlusion deduite ne doit jamais eteindre une surface.
    return np.clip(occlusion, 0.55, 1.0)
