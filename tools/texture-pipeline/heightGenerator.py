"""
Carte de relief.

Prendre la luminance comme relief est le raccourci habituel, et il est faux :
une tache sombre n'est pas un creux, et un joint clair n'est pas une bosse. Le
relief est reconstruit en deux temps, comme le cahier le demande.

D'abord la structure : la luminance lissee sans traverser les aretes, qui donne
les grands volumes, les blocs, les dalles. Ensuite le detail : ce que la
luminance porte de fin, borne pour ne pas transformer du bruit de compression
en grain de surface. Les deux sont melanges selon la matiere, puis etales.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur, guided_filter, luminance, normalize01
from profiles import MaterialProfile


def height(image: np.ndarray, material: MaterialProfile) -> np.ndarray:
    """Relief deduit de la couleur, entre zero et un."""
    lit = luminance(image)

    # Structure : lissage qui respecte les aretes, puis grandes echelles.
    guided = guided_filter(lit, lit, radius=3, epsilon=0.002)
    structure = gaussian_blur(guided, max(1.5, image.shape[0] / 128.0))

    # Detail : ce qui reste, borne aux valeurs courantes pour ecarter le bruit.
    detail = guided - structure
    limit = float(np.percentile(np.abs(detail), 98)) or 1e-3
    detail = np.clip(detail, -limit, limit) / limit * 0.5

    combined = normalize01(structure) + detail * material.detail * 0.35
    return normalize01(combined)
