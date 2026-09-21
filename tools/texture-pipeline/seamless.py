"""
Continuite des bords.

La plupart des textures du jeu sont repetees sur de grandes surfaces : leurs
bords opposes doivent se rejoindre sans couture. Les originaux le font ;
l'agrandissement et le nettoyage peuvent l'abimer, et une reconstruction par
apprentissage encore davantage.

On mesure donc l'ecart entre les bords opposes, et on le corrige quand il
depasse celui de l'original : la texture est decalee d'une demi-image, ce qui
amene la couture au centre, ou elle est fondue, puis remise en place. Rien
d'autre n'est touche.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur


def seam_error(image: np.ndarray) -> tuple[float, float]:
    """
    Ecart moyen entre bords opposes, horizontal puis vertical. Zero signifie
    que la texture se repete sans marque visible.
    """
    left = image[:, 0]
    right = image[:, -1]
    top = image[0, :]
    bottom = image[-1, :]
    horizontal = float(np.abs(left - right).mean())
    vertical = float(np.abs(top - bottom).mean())
    return horizontal, vertical


def repair(image: np.ndarray, width: int = 12) -> np.ndarray:
    """
    Fond les bords opposes l'un dans l'autre.

    Le decalage d'une demi-image amene les deux coutures au centre ; on y
    applique un degrade entre l'image et sa version floue locale, sur quelques
    pixels seulement, puis on remet le decalage. La composition n'est pas
    touchee : seules deux bandes minces sont adoucies.
    """
    height, columns = image.shape[:2]
    rolled = np.roll(np.roll(image, columns // 2, axis=1), height // 2, axis=0)
    blurred = gaussian_blur(rolled, 1.6)

    mask = np.zeros((height, columns), dtype=np.float32)
    center_x = columns // 2
    center_y = height // 2
    ramp = np.linspace(1.0, 0.0, width, dtype=np.float32)
    for offset, value in enumerate(ramp):
        for position in (center_x - offset - 1, center_x + offset):
            if 0 <= position < columns:
                mask[:, position] = np.maximum(mask[:, position], value)
        for position in (center_y - offset - 1, center_y + offset):
            if 0 <= position < height:
                mask[position, :] = np.maximum(mask[position, :], value)

    weight = mask[..., None] if image.ndim == 3 else mask
    merged = rolled * (1 - weight) + blurred * weight
    return np.roll(np.roll(merged, -(height // 2), axis=0), -(columns // 2), axis=1)
