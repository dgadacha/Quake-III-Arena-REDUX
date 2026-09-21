"""
Couleur de base.

Une texture de 1999 porte son eclairage peint : ombres sous les rivets,
reflets sur les aretes, degrade du haut vers le bas. Un rendu moderne calcule
ces ombres et ces reflets lui-meme. Si on garde les deux, on obtient un decor
au contraste excessif, ou chaque creux est double.

On retire donc, en partie seulement, la composante de tres basse frequence de
la luminance : ce qui est retire est un eclairage, ce qui reste est la matiere.
La teinte n'est jamais touchee.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur, luminance


def neutralize(image: np.ndarray, strength: float) -> np.ndarray:
    """
    Aplanit l'eclairage cuit dans la texture.

    La force vaut zero pour ne rien changer, un pour retirer entierement le
    degrade de basse frequence. Les valeurs employees restent autour de la
    moitie : une texture totalement plate perdrait son caractere.
    """
    if strength <= 0:
        return image

    lit = luminance(image)
    # Grande echelle : le sigma vaut un huitieme du cote, donc seuls les
    # degrades larges sont vus, pas les joints ni les rivets.
    sigma = max(2.0, image.shape[0] / 8.0)
    large = gaussian_blur(lit, sigma)
    mean = float(large.mean()) or 1e-3

    # Rapport borne : une zone tres sombre ne doit pas etre remontee au blanc.
    ratio = np.clip(mean / np.maximum(large, 1e-3), 0.55, 1.8)
    corrected = 1.0 + (ratio - 1.0) * strength
    return np.clip(image * corrected[..., None], 0.0, 1.0)
