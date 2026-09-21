"""
Carte de normales.

Les derivees du relief donnent la pente en chaque point ; la normale est le
vecteur qui s'y oppose. La force depend de la matiere : une pierre taillee
accroche la lumiere, une plaque de metal peinte presque pas.

Convention : x vers la droite, y vers le haut, z vers l'observateur, encodee
dans l'intervalle zero-un comme toutes les cartes de normales de tangente.
"""

from __future__ import annotations

import numpy as np

from common import sobel
from profiles import MaterialProfile


def normal(height: np.ndarray, material: MaterialProfile) -> np.ndarray:
    """Carte de normales encodee en couleur."""
    dx, dy = sobel(height)
    strength = material.normal_strength * 8.0

    x = -dx * strength
    y = -dy * strength
    z = np.ones_like(height)

    length = np.sqrt(x * x + y * y + z * z)
    encoded = np.stack([x / length, y / length, z / length], axis=-1)
    return np.clip(encoded * 0.5 + 0.5, 0.0, 1.0)
