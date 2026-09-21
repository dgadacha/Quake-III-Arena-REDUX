"""
Nettoyage avant agrandissement.

Les textures du jeu sont des JPEG de 1999, compresses fort : elles portent des
blocs de huit pixels, du bruit de quantification et des halos autour des
aretes. Agrandir sans nettoyer revient a agrandir ces defauts, et c'est
exactement ce qui donne l'impression d'une texture « rehaussee » plutot que
refaite.

Le nettoyage reste faible et ne traverse pas les aretes : un filtre guide lisse
l'interieur des plages sans toucher aux joints, aux rivets ni aux bordures, qui
sont precisement ce qui fait l'identite de ces textures.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur, guided_filter, luminance, sobel


def clean(image: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """
    Retire le grain de compression en gardant la structure.

    Le lissage n'est pas applique uniformement : il est module par un masque
    d'aretes. Les plages plates, ou vit le grain de compression, sont lissees
    franchement ; les joints, les rivets et les bordures, qui font l'identite
    de ces textures, ne sont pas touches. Sans ce masque, un filtre assez fort
    pour retirer le grain efface aussi les joints, et assez doux pour garder
    les joints ne retire rien.
    """
    if strength <= 0:
        return image

    guide = luminance(image)
    edges = edge_mask(guide)

    # Filtre guide large : il aplanit le grain sur plusieurs pixels.
    epsilon = 0.0025 * min(2.0, strength)
    smooth = np.empty_like(image)
    for channel in range(3):
        smooth[..., channel] = guided_filter(image[..., channel], guide, radius=3, epsilon=epsilon)

    # Le melange suit le masque : fort dans le plat, nul sur une arete.
    mix = np.clip(0.9 * min(1.6, strength), 0.0, 1.0) * (1.0 - edges)
    weight = mix[..., None]
    return np.clip(image * (1 - weight) + smooth * weight, 0.0, 1.0)


def edge_mask(plane: np.ndarray) -> np.ndarray:
    """
    Ou se trouvent les aretes, entre zero et un.

    L'amplitude du gradient est etalee sur ses propres quantiles : une texture
    peu contrastee garde ainsi ses aretes, et une texture tres contrastee ne
    devient pas un masque plein.
    """
    dx, dy = sobel(gaussian_blur(plane, 0.8))
    magnitude = np.hypot(dx, dy)
    low = float(np.percentile(magnitude, 60))
    high = float(np.percentile(magnitude, 96))
    if high - low < 1e-6:
        return np.zeros_like(plane)
    mask = np.clip((magnitude - low) / (high - low), 0.0, 1.0)
    # Adouci : une frontiere franche entre lisse et non lisse se verrait.
    return gaussian_blur(mask, 1.0)


def grain_level(image: np.ndarray) -> float:
    """
    Quantite de grain haute frequence dans les plages plates.

    On compare l'image a une version legerement floutee, et on ne regarde que
    les endroits sans arete : ce qui reste est du grain, pas du dessin. C'est
    la mesure qui dit si une texture a vraiment perdu son bruit de
    compression, independamment du filtre employe pour l'enlever.
    """
    guide = luminance(image)
    residual = np.abs(guide - gaussian_blur(guide, 1.0))
    flat = edge_mask(guide) < 0.25
    if not flat.any():
        return 0.0
    return float(residual[flat].mean())


def artefact_level(image: np.ndarray) -> float:
    """
    Estime le bruit de compression, pour doser le nettoyage. C'est la meme
    mesure que le grain, gardee sous son ancien nom parce qu'elle sert a
    regler la force et non a rendre compte du resultat.
    """
    return grain_level(image)
