"""
Carte d'emission.

Seules les textures reconnues comme lumineuses en produisent une : lampes,
ecrans, energie, coulees de lave. Le reste rend une carte vide, et le materiau
n'en recoit aucune.

La zone lumineuse est celle qui se detache nettement en luminance, elargie de
quelques pixels : c'est ce qui alimente le halo, et un halo qui suit
exactement le contour d'un pixel se voit.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur, luminance
from classifier import MaterialType


def emissive(image: np.ndarray, kind: MaterialType) -> np.ndarray | None:
    """Carte d'emission, ou rien si la matiere n'emet pas."""
    if kind not in (MaterialType.EMISSIVE, MaterialType.LIQUID):
        return None

    lit = luminance(image)
    threshold = float(np.percentile(lit, 70))
    span = max(1e-3, float(lit.max()) - threshold)
    mask = np.clip((lit - threshold) / span, 0.0, 1.0)
    mask = gaussian_blur(mask, 1.2)

    return np.clip(image * mask[..., None], 0.0, 1.0)
